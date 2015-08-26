require('dotenv').load();

var AWS = require('aws-sdk');
var doc = require('dynamodb-doc');
var async = require('async');
var dynamodb = new doc.DynamoDB();

actions = {
  'handleDeployment' : require('./lib/handle_deployment.js')
  ,'monitorDeployment':require('./lib/monitor_deployment.js')
}

var config = {"opsWorksStackId": process.env.OPSWORKS_STACK_ID
          , "opsWorksAppId": process.env.OPSWORKS_APP_ID
          , "monitoringTopicArn":process.env.MONITORING_TOPIC_ARN
          , "notificationTopicArn":process.env.NOTIFICATION_TOPIC_ARN
          , "appName" : process.env.APP_NAME
          , "lbUpstreamUser": process.env.LB_UPSTREAM_USER
          , "lbUpstreamPassword": process.env.LB_UPSTREAM_PASSWORD
          , "lbHost" : process.env.LB_HOST
          , "lbUpstreamPort" : process.env.LB_UPSTREAM_PORT
          , "artifactBucket": process.env.ARTIFACT_BUCKET
          , "deploymentTimeout" : process.DEPOYMENT_TIMEOUT
          , "submodules" : [{"module":"frontend", "archiveName": "ui.tgz"},{"module":"backend", "archiveName":"engine.tgz"}]
        };

exports.handler = function(event, context) {
    //console.log('Received event:', JSON.stringify(event, null, 2));
    if(event.operation) {
      var operation = event.operation;
      delete event.operation;
    } else if(event.Records[0].Sns) {
      var message = JSON.parse(event.Records[0].Sns.Message);
      if(!message.command) {
        message.command = 'deploy';
      }
      if(!message.action && message.Records) {
        var s3 = message.Records[0].s3;
        if(s3) {
            if(s3.configurationId == "ArtifactUploaded"){
              message.action = 'handleDeployment';
              message.command = 'prepare_staging';
            }
        }
      }
      // Skip processing monitoring call, if it's disabled in the configuration
      if(message.action == 'monitorDeployment' && !process.env.MONITOR_ENABLED) {
        console.log("Skipped processing message : %s", JSON.stringify(event, null, 2))
        context.succeed();
        return;
      }

      config.topicArn = event.Records[0].Sns.TopicArn;
      config.messageSent = Date.parse(event.Records[0].Sns.Timestamp);
      var targetAction = actions[message.action];
      targetAction(message, config, context);

      return;
    }
};
