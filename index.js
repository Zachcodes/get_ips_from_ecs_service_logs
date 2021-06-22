const AWS = require('aws-sdk');
const awsConfig = { region: 'us-west-2' };
const CloudWatch = new AWS.CloudWatchLogs(awsConfig);
const Route53 = new AWS.Route53(awsConfig);
const ELB = new AWS.ELBv2(awsConfig);
const EC2 = new AWS.EC2(awsConfig);

if(process.argv.length < 3) {
    console.warn("Missing required log name parameters");
    process.exit(1);
}

class ServiceIpMapper {
    constructor(logGroupName, logStreamNamePrefix) {
        this.logGroupName = logGroupName;
        this.logStreamNamePrefix = logStreamNamePrefix;
        this.uniqueIps = {};
        this.streamQueue = [];
        this.oldestLogTimestamps = [];
    }

    async generateIpMapping() {
        await this.buildEC2IpDict();
        await this.generateDomainsWithIpAddresses();
        this.getUniqueIpsFromZoneMap();
        await this.getStreamsWithEvents();
        await this.processStreams();
        this.createRequestIpDictionary();
        this.matchRequestIpsToZoneIpMap();
    }

    async generateDomainsWithIpAddresses() {
        const zoneMap = {};
        const zones = await Route53.listHostedZones({}).promise();
        const promises = [];
        zones.HostedZones.forEach( zone => {
            zoneMap[zone.Id] = { name: zone.Name, ipMap: {} };
            promises.push(new Promise(async ( resolve ) => {
                const resourceSet = await Route53.listResourceRecordSets({ HostedZoneId: zone.Id }).promise();
                resourceSet.ResourceRecordSets.forEach( set => {
                    if(zoneMap[zone.Id].ipMap[set.Name]) {
                        zoneMap[zone.Id].ipMap[set.Name] = zoneMap[zone.Id].ipMap[set.Name].concat([...set.ResourceRecords]);
                    }
                    else {
                        zoneMap[zone.Id].ipMap[set.Name] = [...set.ResourceRecords];
                    }
                });
                resolve();
            }))
        });
        await Promise.all(promises);
        this.zoneMap = Object.keys(zoneMap).reduce( (finalMap, zoneId) => {
            finalMap[zoneMap[zoneId].name] = { ipMap: zoneMap[zoneId].ipMap };
            return finalMap;
        }, {});
    }

    async buildEC2IpDict() {
        const instances = await ELB.describeLoadBalancers({}).promise();
        const elbIps = {};
        const vpcIds = instances.LoadBalancers.reduce( (vpcs, loadBalancer) => {
            if(vpcs.indexOf(loadBalancer.VpcId) === -1) {
                vpcs.push(loadBalancer.VpcId)
            }
            return vpcs;
        }, []);
        const interfaces = await EC2.describeNetworkInterfaces({ Filters: [ { Name: 'vpc-id', Values: vpcIds } ] }).promise();
        interfaces.NetworkInterfaces.forEach( networkInterface => {
            const ipsInInterface = [
                networkInterface.PrivateIpAddress,
                networkInterface.PrivateIpAddresses
                .map( privateIp => {
                    const privateArr = [ privateIp.PrivateIpAddress ];
                    if(privateIp.Association) {
                        privateArr.push(privateIp.PublicIp);
                    }
                    return privateArr;
                }).flat()
            ];
            ipsInInterface
            .forEach( ip => {
                if(!elbIps[ip]) {
                    elbIps[ip] = {
                        relatedNetworkInterfaces: []
                    }
                }
                elbIps[ip]['relatedNetworkInterfaces']
                .push({ id: networkInterface.NetworkInterfaceId, description: networkInterface.Description });
            });
        });
        this.uniqueIps = elbIps;
    }

    getUniqueIpsFromZoneMap() {
        Object.keys(this.zoneMap)
        .map( zoneName => {
            for(const resourceName in this.zoneMap[zoneName].ipMap) {
                this.zoneMap[zoneName].ipMap[resourceName]
                .forEach( ipArr => {
                    if(!this.uniqueIps[ipArr.Value] || !this.uniqueIps[ipArr.Value].relatedNetworkInterfaces) {
                        this.uniqueIps[ipArr.Value] = this.uniqueIps[ipArr.Value] 
                        ? { ...this.uniqueIps[ipArr.Value], relatedNetworkInterfaces: []} 
                        : { relatedNetworkInterfaces: [] };
                    }
                    this.uniqueIps[ipArr.Value].relatedNetworkInterfaces.push({ zone: zoneName, resourceName: resourceName });
                })
            }
        });
    }

    async getStreamsWithEvents() {
        const { logStreams } = await CloudWatch.describeLogStreams({
            logGroupName: this.logGroupName,
            logStreamNamePrefix: this.logStreamNamePrefix
        }).promise();
        this.streams = logStreams.filter( stream => stream.hasOwnProperty('firstEventTimestamp'));
    }

    async processStreams() {
        this.processedStreamsCount = 0;
        this.intervalId = setInterval(() => {
            console.log(`Event queue length: ${this.streamQueue.length}`);
            const eventsToProcess = this.streamQueue.splice(0, 5);
            this.processedStreamsCount += eventsToProcess.length;
            eventsToProcess.map( event => event[0].apply(this, [...event.slice(1)]));
        }, 1500);
        const logEventsPromises = this.streams.map( stream => {
            return new Promise(( res, rej ) => this.getAllEventsForStream(res, rej, stream.logStreamName))
        });
        const logEvents = await Promise.all(logEventsPromises);
        clearInterval(this.intervalId);
        console.log(`Processed ${this.processedStreamsCount} total log streams`);
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
                if(!data || !data.events.length) return res(onlyApiReqs);;
                onlyApiReqs = onlyApiReqs.concat(
                    data.events.filter( event => {
                    return /"(GET|PUT|POST)/.test(event.message)
                    })
                    .filter( event => !/(?:connect\(\) failed)/.test(event.message))
                    .map( event => event.message)
                );
                if(nextForwardToken == data.nextForwardToken || onlyApiReqs.length >= 5000) {
                    this.oldestLogTimestamps.push(this.formatDateForLog(data.events[data.events.length - 1]));
                    return res(onlyApiReqs);
                }
                nextForwardToken = data.nextForwardToken;
                this.streamQueue.push([loopStream]);
            });
        }
        this.streamQueue.push([loopStream, true]);
    }

    formatDateForLog(event) {
        const timestamp = event.timestamp;
        const date = new Date(timestamp);
        const year = date.getFullYear();
        const dayOfMonth = date.getDate();
        const month = date.getMonth() + 1;
        return `${year}/${month}/${dayOfMonth}`;
    }
 
    createRequestIpDictionary() {
        this.ipDictionary = this.logEvents.flat()
            .reduce( (dict, message) => {
                const ipAddressMatches = message.match(/(?:\d+\.){3,5}\d+/g);
                const reqUrlMatches = message.match(/((\/[\d\w-]+)+\sHTTP)/);
                if(!ipAddressMatches || !reqUrlMatches) return dict;
                const reqUrl = reqUrlMatches[0].split(' ')[0];
                ipAddressMatches.forEach( requestingIp => {
                    if(!dict[requestingIp] || !dict[requestingIp][reqUrl]) {
                        dict[requestingIp] = {
                            [reqUrl]: { hits: 1 }
                        }
                    }
                    else {
                        dict[requestingIp][reqUrl]['hits'] = dict[requestingIp][reqUrl]['hits'] + 1;
                    }
                });
                return dict;
        }, {});
    }

    matchRequestIpsToZoneIpMap() {
        for(const requestIp in this.ipDictionary) {
            if(this.uniqueIps[requestIp]) {
                const sortedEndpointsByHits = Object.keys(this.ipDictionary[requestIp])
                .map( endpointRequested => {
                    return { [endpointRequested]: this.ipDictionary[requestIp][endpointRequested]['hits'] }
                })
                .sort((endpointA, endpointB) => {
                    if (endpointA.hits < endpointB.hits) {
                        return -1;
                    }
                    if (endpointA.hits > endpointB.hits) {
                        return 1;
                    }
                    return 0;
                })
                .slice(0, 10);
                console.log("\n*** FOUND A MATCH ***\n");
                console.log(`Request Ip: ${requestIp}`);
                console.log(`\nMatched Route 53 ip: \n`);
                console.log(this.uniqueIps[requestIp]);
                console.log(`\nTop routes requested by hit count:`);
                console.log(sortedEndpointsByHits);
            }
        }
        console.log(`\n\nOldest Timestamps Requested`);
        console.log(this.oldestLogTimestamps);
    }
}

const mapper = new ServiceIpMapper(process.argv[2], process.argv[3]);
mapper.generateIpMapping();