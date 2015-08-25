var AWS = require('aws-sdk');
var async = require('async');
var contextHolder = require('./app_context_holder.js');
var dbHandler = require('./db_handler.js');
var targetEnvSetHelper = require('./target_envset_helper.js');
var utils = require('./utils.js');

module.exports = function(message, config, context) {
  var s3 = contextHolder.s3;
  var opsworks = contextHolder.opsworks;
  var sns = contextHolder.sns;
  var dynamodb = contextHolder.dynamo;

  var validateDeploymentStatus = function(command, callback) {
    dbHandler.getDeploymentStatus(config.appName, function(err, data) {
      if (err) {
        return callback(err);
      }

      deploymentStatus = data.deployment_status;

      var allowProgress = false;
      // Allow pipeline to begin if this command first in pipeline and pipeline is NOT already in progress
      if (contextHolder.COMMANDS_IN_PIPELINE.indexOf(command) == 0) {
        if (data.pipeline_status == contextHolder.STATUS_NOTRUNNING) {
          allowProgress = true;
        }
      } else if (data.pipeline_status == contextHolder.STATUS_RUNNING) {
        // Allow pipeline to progress if pipeline is already in progress and the command is not the trigger
        // This is OK since the trigger is the only point we need to control. Everything else is programatically decided

        allowProgress = true;
      }

      if (!allowProgress && !process.env.DEBUG) {
        console.log('Invalid State: Skipping deployment.', deploymentStatus);
        callback(new Error("Invalid State: Skipping deployment. "));
        return;
      }

      callback(null, data);
    });
  }


  var beginDeployment = function(command, targetEnvConfig, callback) {
    // Begins an OpsWorks deployment or executes one or more recipes
    // Each deployment execution is monitored using a SNS topic and delivery to 'monitorDeployment' function

    var params = {};
    params.StackId = config.opsWorksStackId;
    params.CustomJson = JSON.stringify(targetEnvConfig.customJson);
    params.InstanceIds = targetEnvConfig.targetEnvInstanceIds;

    if (command == "deploy") {
      params.AppId = config.opsWorksAppId;
      params.Command = {
        Name: command
      };
    } else {
      params.Command = {
        Name: 'execute_recipes',
        Args: {
          "recipes": targetEnvConfig.commandSpec.recipes
        }
      };
    }

    opsworks.createDeployment(params, function(err, data) {
      if (err) {
        console.log('Deployment to OpsWorks failed. {%s}', err);
        return callback(err);
      }
      console.log('OpsWorks deployment %s triggered for command %s. ', data.DeploymentId, command);
      utils.publishMonitorMessage(config.monitoringTopicArn, 'monitorDeployment', command, data.DeploymentId, callback);
    });
  };

  async.waterfall([
      function(callback) {
        validateDeploymentStatus(message.command, callback);
      },
      function(data, callback) {
        dbHandler.updateDeploymentStatus(config.appName, utils.buildPipelineStatus(message.command, contextHolder.STATUS_INPROGRESS), data, contextHolder.STATUS_RUNNING, callback);
      },
      function(callback) {
        targetEnvSetHelper(message, config, context, callback);      },
      function(targetEnvConfig, callback) {
        beginDeployment(message.command, targetEnvConfig, callback);
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
}
