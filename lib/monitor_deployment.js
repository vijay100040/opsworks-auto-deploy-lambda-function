var async = require('async');
var contextHolder = require('./app_context_holder.js');
var opsworks = contextHolder.opsworks;
var sns = contextHolder.sns;
var dbHandler = require('./db_handler.js');
var utils = require('./utils.js');

module.exports = function(message, config, context) {
  var deployID = message.deploymentId;
  var command = message.command;

  var minsElapsed = Math.ceil((Date.now() - config.messageSent) / 60000);

  function notifyIfRequired(deploymentId, command, pipelineStatus, forceNotify, callback) {
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
        callback(null, data);
      });
    }
    callback();
  }


  function processMonitoringStatus(command, deployID, lastDeploymentData, callback) {
    var params = {
      DeploymentIds: [deployID]
    };
    opsworks.describeDeployments(params, function(err, data) {
      if (err) return callback(err);

      if (data.Deployments.length > 0) {
        var commandStatus = data.Deployments[0].Status;
        var deploymentStatus = '';
        var pipelineStatus = contextHolder.STATUS_NOTRUNNING;

        var commandIndex = contextHolder.COMMANDS_IN_PIPELINE.indexOf(command);
        var nextCommand = '';
        var forceNotify = false;

        switch (commandStatus) {
          case 'successful':
            var nextCommandIndex = commandIndex + 1;
            if (nextCommandIndex < contextHolder.COMMANDS_IN_PIPELINE.length) {
              // There are still other commands to execute, mark pipeline as inprogress
              pipelineStatus = contextHolder.STATUS_RUNNING;

              nextCommand = contextHolder.COMMANDS_IN_PIPELINE[nextCommandIndex];
            }
            break;
          case 'failed':
            break;
          default:
            commandStatus = contextHolder.STATUS_INPROGRESS;
            if (minsElapsed > config.deploymentTimeout) {
              commandStatus = 'failed';
              console.log('Opsworks deployment %s timed out after %s minutes', deployID, minsElapsed);
            } else {
              // Marking this request context as fail would cause SNS to try and redeliver this again after a delay
              var waitingError = new Error("Waiting for command '" + command + "' with ID " + deployID + " to complete. elapsed :" + minsElapsed);
              waitingError.subtype = 'waiting';

              return callback(waitingError);
            }
        }
        deploymentStatus = utils.buildPipelineStatus(command, commandStatus);


        if (commandStatus == "failed") {
          currentCommandSpec = utils.findByCommand(contextHolder.COMMANDS, command);
          if (currentCommandSpec.onfailCommand == contextHolder.COMMAND_HALT_PIPELINE) {
            // A command failed, and pipeline HALT was requested.
            // This can only be manually changed in the DB at this time.
            pipelineStatus = contextHolder.STATUS_HALTED;
            forceNotify = true;
            console.log('Command %s failed. Pipeline halted. To resume, update the pipeline_status to "NOT_RUNNING"', command);
          } else {
            nextCommand = currentCommandSpec.onfailCommand;
            pipelineStatus = contextHolder.STATUS_NOTRUNNING;
            console.log('Command %s failed. Will call onfailCommand if it exists', command);
          }
        }

        async.waterfall([
            function(callback) {
              dbHandler.updateDeploymentStatus(config.appName, deploymentStatus, lastDeploymentData.item_version, pipelineStatus, deployID, command, callback);
            },
            function(callback) {
              notifyIfRequired(command, deployID, pipelineStatus, forceNotify, utils.printCallback);
              if (nextCommand) {
                utils.publishMonitorMessage(config.monitoringTopicArn, 'handleDeployment', nextCommand, 'NA', callback);
              }
            }
          ],
          callback
        );

      } else {
        callback();
      }
    });
  }


  function processMonitoringById(command, deployID, lastDeploymentData) {
    console.log('Processing monitoring message for command %s with id %s',command, deployID);
    processMonitoringStatus(command, deployID, lastDeploymentData, function(err, results) {
      if (err) {
        console.log('Error in process monitorig', err);
        if (err.subtype && err.subtype == 'waiting') {
          context.fail(err.message);
          return;
        }
        context.fail(err);
        return;
      }
      console.log('Marking monitoring message for %s as successfully done', deployID);

      context.succeed();
    });
  }

  dbHandler.getDeploymentStatus(config.appName, function(err, data) {
    if (data.pipeline_status === contextHolder.STATUS_NOTRUNNING || data.pipeline_status === contextHolder.STATUS_HALTED) {
      context.succeed();
      return;
    }

    // We force monitor only the last deployment_id / command to ensure integrity
    deployID = data.last_deployment_id;
    command = data.last_command;

    // There was no command ID available. Try processing last deployment command from database
    processMonitoringById(command, deployID, data);
  });
};
