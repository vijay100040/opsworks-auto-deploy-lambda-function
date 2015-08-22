var async = require('async');
//var jobHelper = require('./job_functions.js');
var contextHolder = require('./app_context_holder.js');
var opsworks = contextHolder.opsworks;
var dbHandler = require('./db_handler.js');
var utils = require('./utils.js');

module.exports = function(message, config, context) {
  var COMMANDS_IN_PIPE = ['deploy', 'test_staging', 'prepare_stg_for_prod', 'switch_to_prod', 'cleanup'];
  var NOTIFY_STATUSES_REGEXP = ['.*failed$', '.*timedout$', 'switch_to_prod__successful$', 'cleanup__successful$'];


  var deployID = message.deploymentId;
  var minsElapsed = Math.ceil((Date.now() - config.messageSent) / 60000);
  if(minsElapsed <=1) {
    console.log(message);
  }

  var publishNotificationMessage = function(config, notificationMessage, callback) {
    var params = {
      Message: notificationMessage,
      Subject: 'OpsWorks Deployment Notification',
      TargetArn: config.notificationTopicArn
    };
    sns.publish(params, callback);
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

        switch (deployStatus) {
          case 'successful':
            console.log('Deploy succeeded');
            break;
          case 'failed':
            console.log('Deploy failed');
            break;
          default:
            deployStatus = 'inprogress';
            if (minsElapsed > 9) {
              /*jobHelper.markFail(message.Job, 'OpsWorks deploy timed out', function() {
                  context.succeed("OpsWorks deploy timed out");
              });*/
              deployStatus = 'timedout';
              console.log('Opsworks deployment %s timed out after 9 minutes', deployID);
            } else {
              continueWaiting = true;
              console.log('Deploy still running, elapsed: ' + minsElapsed);
              context.fail("Still waiting");
            }
        }

        pipelineStatus = [command, deployStatus].join('__');
        if(utils.isNotificationRequired(NOTIFY_STATUSES_REGEXP, pipelineStatus)){
          // This status requires a notification, publish to notification topic.
          // Any subscribers will be notified.
          // We only support a JSON message now.
          var notificationMessage = JSON.stringify({
            deploymentId: deployID,
            command: message.command,
            status:pipelineStatus
          });

          publishNotificationMessage(config, message, function(){});
        }

        if (continueWaiting) {
          context.fail("Still waiting for deployment command '" + command + "' with ID " + deployID + " to complete");
          return;
        }
        async.waterfall([
            function(callback) {
              dbHandler.getDeploymentStatus(config.appName, callback);
            },
            function(data, callback) {
              dbHandler.updateDeploymentStatus(config.appName, pipelineStatus, data, callback);
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
