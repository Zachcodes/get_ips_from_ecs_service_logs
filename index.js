const AWS = require('aws-sdk');
const awsConfig = { region: 'us-west-2' };
const CloudWatch = new AWS.CloudWatchLogs(awsConfig);
const Route53 = new AWS.Route53(awsConfig);

if(process.argv.length < 3) {
    console.warn("Missing required log name parameters");
    process.exit(1);
}

class ServiceIpMapper {
    constructor(logGroupName, logStreamNamePrefix) {
        this.logGroupName = logGroupName;
        this.logStreamNamePrefix = logStreamNamePrefix;
    }

    async generateIpMapping() {
        await this.generateDomainsWithIpAddresses();
        this.getUniqueIpsFromZoneMap();
        await this.getStreamsWithEvents();
        await this.processStreams();
        this.createRequestIpDictionary();
        this.matchRequestIpsToZoneIpMap();
    }

    async generateDomainsWithIpAddresses() {
        const zoneMap = {};
        return new Promise(( res ) => {
            Route53.listHostedZones({}, async (err, zones) => {
                const promises = [];
                zones.HostedZones.forEach( zone => {
                    zoneMap[zone.Id] = { name: zone.Name, ipMap: {} };
                    promises.push(new Promise(( resolve ) => {
                        Route53.listResourceRecordSets({ HostedZoneId: zone.Id }, (err, resourceSet) => {
                            resourceSet.ResourceRecordSets.forEach( set => {
                                if(zoneMap[zone.Id].ipMap[set.Name]) {
                                    zoneMap[zone.Id].ipMap[set.Name] = zoneMap[zone.Id].ipMap[set.Name].concat([...set.ResourceRecords]);
                                }
                                else {
                                    zoneMap[zone.Id].ipMap[set.Name] = [...set.ResourceRecords];
                                }
                            });
                            
                            resolve();
                        });
                    }))
                });
                await Promise.all(promises);
                this.zoneMap = Object.keys(zoneMap).reduce( (finalMap, zoneId) => {
                    finalMap[zoneMap[zoneId].name] = { ipMap: zoneMap[zoneId].ipMap };
                    return finalMap;
                }, {});
                res();
            });
        });
    }

    getUniqueIpsFromZoneMap() {
        this.uniqueIps = {};
        Object.keys(this.zoneMap).map( zoneName => {
            for(const resourceName in this.zoneMap[zoneName].ipMap) {
                this.zoneMap[zoneName].ipMap[resourceName].forEach( ipArr => {
                    if(this.uniqueIps[ipArr.Value]) {
                        this.uniqueIps[ipArr.Value].push({ zone: zoneName, resourceName: resourceName });
                    }
                    else {
                        this.uniqueIps[ipArr.Value] = [{ zone: zoneName, resourceName: resourceName }];
                    }
                })
            }
        })
    }

    async getStreamsWithEvents() {
        return new Promise(( res, rej ) => {
            CloudWatch.describeLogStreams({
                logGroupName: this.logGroupName,
                logStreamNamePrefix: this.logStreamNamePrefix
            }, (err, data) => {
                if(err) rej(err);
                this.streams =  data.logStreams.filter( stream => stream.hasOwnProperty('firstEventTimestamp'));
                res();
            });
        })
    }

    async processStreams() {
        const logEventsPromises = this.streams.map( stream => {
            return new Promise(( res, rej ) => this.getAllEventsForStream(res, rej, stream.logStreamName))
        });
        const logEvents = await Promise.all(logEventsPromises);
        this.logEvents = logEvents.filter( eventArr => eventArr.length);
    }

    getAllEventsForStream(res, rej, logStreamName) {
        let nextForwardToken = '';
        let onlyApiReqs = [];
        function loopStream(useStart = false) {
            const options = {
                logGroupName: this.logGroupName,
                logStreamName,
                startFromHead: useStart
            }
            if(nextForwardToken) {
                options.nextToken = nextForwardToken;
            }

            CloudWatch.getLogEvents(options, (err, data) => {
                if(err) rej(err);
                onlyApiReqs = onlyApiReqs.concat(
                    data.events.filter( event => {
                    return /"(GET|PUT|POST)/.test(event.message)
                    })
                    .filter( event => !/(?:connect\(\) failed)/.test(event.message))
                    .map( event => event.message)
                );
                if(nextForwardToken == data.nextForwardToken || onlyApiReqs.length >= 1000 || !data.events.length) {
                    return res(onlyApiReqs);
                }
                nextForwardToken = data.nextForwardToken;
                loopStream.call(this);
            });
        }
        loopStream.call(this, true);
    }
 
    createRequestIpDictionary() {
        this.ipDictionary = this.logEvents.flat()
            .reduce( (dict, message) => {
                const ipAddressMatches = message.match(/(\d+\.{1})+\d/);
                const reqUrlMatches = message.match(/((\/[\d\w-]+)+\sHTTP)/);
                if(!ipAddressMatches || !reqUrlMatches) return dict;
                const reqUrl = reqUrlMatches[0].split(' ')[0];
                const requestingIp = ipAddressMatches[0];
                if(!dict[requestingIp] || !dict[requestingIp][reqUrl]) {
                    dict[requestingIp] = {
                        [reqUrl]: { hits: 1 }
                    }
                }
                else {
                    dict[requestingIp][reqUrl]['hits'] = dict[requestingIp][reqUrl]['hits'] + 1;
                }
                return dict;
        }, {});
    }

    matchRequestIpsToZoneIpMap() {
        for(const requestIp in this.ipDictionary) {
            if(this.uniqueIps[requestIp]) {
                console.log("*** FOUND A MATCH ***\n");
                console.log(`Request Ip: ${requestIp}`);
                console.log(`Matched Route 53 ip: \n`);
                console.log(this.uniqueIps[requestIp])
            }
        }
    }
}

const mapper = new ServiceIpMapper(process.argv[2], process.argv[3]);
mapper.generateIpMapping();