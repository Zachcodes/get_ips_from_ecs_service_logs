const AWS = require('aws-sdk');
const CloudWatch = new AWS.CloudWatchLogs({ region: 'us-west-2' });

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
        await this.getStreamsWithEvents();
        await this.processStreams();
        this.createIpDictionary();
        console.log("IP Dictionary\n\n");
        console.log(this.ipDictionary);
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
 
    createIpDictionary() {
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
}

const mapper = new ServiceIpMapper(process.argv[2], process.argv[3]);
mapper.generateIpMapping();