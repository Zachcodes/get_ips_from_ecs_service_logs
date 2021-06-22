This is a utility script that allows you to grab the nginx logs of any ECS service and then filter down which endpoints have been requested and from where as well as a hit count. Useful for backtracing in Route 53 to find the AWS services in your region that are making requests. It also pulls in all EC2 load balancers at the time of running the script and grabs all their ip addresses so we can match against those.

Run the script like so

1. run `npm i` from the root directory
2. run `node index.js the_log_group_name the_log_stream_prefix`

Note:

You can find the log group name and log stream by going to 
ECS -> Cluster -> Service -> Logs -> Select log group ( Nginx one ) -> Click task id hyperlink next to log -> scroll to section marked "Containers" and expand the Nginx label
At this point you should see awslogs-group and awslogs-stream-prefix
Pain in the ass to get to I know, but hey, it's AWS in the browser
