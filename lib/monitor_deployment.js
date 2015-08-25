var async = require('async');
var contextHolder = require('./app_context_holder.js');
var opsworks = contextHolder.opsworks;
var sns = contextHolder.sns;
var dbHandler = require('./db_handler.js');
var utils = require('./utils.js');

module.exports = function(message, config, context) {

  var deployID = message.deploymentId;
  var minsElapsed = Math.ceil((Date.now() - config.messageSent) / 60000);

  var notifyIfRequired = function(deploymentId, command, pipelineStatus, forceNotify, callback) {
    if (forceNotify || utils.isNotificationRequired(contextHolder.NOTIFY_STATUSES_REGEXP, pipelineStatus)) {
      // This status requires a notification, publish to notification topic.
      // Any subscribers will be notified.
      // We only support a JSON message now.
      var notificationMessage = JSON.stringify({
        deploymentId: deploymentId,
        command: command,
        status: pipelineStatus
      });

      var params = {
        Message: notificationMessage,
        Subject: 'OpsWorks Deployment Notification',
        TargetArn: config.notificationTopicArn
      };
      console.log('Notifying message to notification topic %s', config.notificationTopicArn);

      sns.publish(params, function(err, data) {
        if (err) {
          console.log(err);
          return callback(err);
        }
        callback();
      });
    }
  }

  var processMonitoringStatus = function(command, deployID, callback) {
    var params = {
      DeploymentIds: [deployID]
    };
    opsworks.describeDeployments(params, function(err, data) {
      if (err) return callback(err);

      if (data.Deployments.length > 0) {
        var deployStatus = data.Deployments[0].Status;
        var continueWaiting = false;
        var pipelineStatus = '';
        var markPipelineInProgress = false;
        var commandIndex = contextHolder.COMMANDS_IN_PIPELINE.indexOf(command);

        switch (deployStatus) {
          case 'successful':
            console.log('Deploy succeeded');
            if ((commandIndex + 1) < contextHolder.COMMANDS_IN_PIPELINE.length) {
              // Last Command, mark pipeline
              markPipelineInProgress = true;
            }
            break;
          case 'failed':
            console.log('Deploy failed');
            break;
          default:
            deployStatus = 'inprogress';
            if (minsElapsed > 9) {
              deployStatus = 'timedout';
              console.log('Opsworks deployment %s timed out after 9 minutes', deployID);
            } else {
              continueWaiting = true;
              markPipelineInProgress = true;
              context.fail('Deploy still running, elapsed: ' + minsElapsed);
            }
        }
        pipelineStatus = utils.buildPipelineStatus(command, deployStatus);

        notifyIfRequired(command, deployID, pipelineStatus, false, utils.printCallback);

        if (continueWaiting) {
          context.fail("Still waiting for deployment command '" + command + "' with ID " + deployID + " to complete");
          return;
        }
        async.waterfall([
            function(callback) {
              dbHandler.getDeploymentStatus(config.appName, callback);
            },
            function(data, callback) {
              dbHandler.updateDeploymentStatus(config.appName, pipelineStatus, data, markPipelineInProgress, callback);
            },
            function(callback) {
              var nextCommandIndex = commandIndex + 1;

              if (nextCommandIndex < contextHolder / contextHolder.COMMANDS_IN_PIPELINE.length) {
                nextCommand = contextHolder.COMMANDS_IN_PIPELINE[nextCommandIndex];
                utils.publishMonitorMessage(config.monitoringTopicArn, 'handleDeployment', nextCommand, 'NA', callback);
                return;
              }
            }
          ],
          function(err, results) {
            if (err) {
              console.log('error', err);
              context.fail(err);
              return;
            }
            context.succeed();
          }
        );

      } else {
        callback();
      }
    });
  }

  processMonitoringStatus(message.command, deployID, function() {

    //context.succeed("Status updated");
  });

}
