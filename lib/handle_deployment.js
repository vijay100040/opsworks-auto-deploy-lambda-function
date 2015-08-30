var AWS = require('aws-sdk');
var async = require('async');
var contextHolder = require('./app_context_holder.js');
var dbHandler = require('./db_handler.js');
var targetEnvSetHelper = require('./target_envset_helper.js');
var utils = require('./utils.js');
var moment = require('moment');

module.exports = function(message, config, context) {
  var s3 = contextHolder.s3;
  var opsworks = contextHolder.opsworks;
  var sns = contextHolder.sns;
  var dynamodb = contextHolder.dynamo;
  var jobData = {};
  jobData.config = config;
  jobData.dbUpdated = false;
  jobData.deploymentId = 'NEW';
  var locked = false;

  function validateDeploymentStatus(jobData, command, callback) {
    dbHandler.getDeploymentStatus(jobData.config.appName, function(err, data) {
      if (err) {
        return callback(err);
      }

      deploymentStatus = data.deployment_status;

      var allowProgress = false;
      // Allow pipeline to begin if this command first in pipeline and pipeline is NOT already in progress
      if (contextHolder.COMMANDS_IN_PIPELINE.indexOf(command) === 0) {
        if (data.pipeline_status == contextHolder.STATUS_NOTRUNNING) {
          allowProgress = true;
        }
      } else if (data.pipeline_status == contextHolder.STATUS_RUNNING) {
        // Allow pipeline to progress if pipeline is already in progress and the command is not the trigger
        // This is OK since the trigger is the only point we need to control. Everything else is programatically decided

        allowProgress = true;
      }
      allowProgress = allowProgress || jobData.config.overrideStatusCheck == 1;

      if (!allowProgress) {
        var startDate = moment(data.last_updated_datetime, 'x');
        var endDate = moment();
        var minsElapsedSinceLastUpdate = endDate.diff(startDate, 'minutes');
        if (minsElapsedSinceLastUpdate >= config.deploymentTimeout) {
          // The deployment has not been possibly monitored to be closed. Maybe we can allow this to pass through.
        }

        var error = new Error("Invalid State: Skipping deployment. Current Status " + deploymentStatus);
        error.subtype = 'skip_deployment';
        return callback(error);
      }

      callback(null, data);
    });
  }

  function getArtifactMetadata(jobData, resultCallback) {
    var fnConfig = jobData.config;

    // We pickup only the latest versions of artifacts for deployment.
    async.forEachOf(fnConfig.submodules,
      function(item, key, callback) {
        var params = {
          Bucket: fnConfig.artifactBucket,
          Key: item.archiveName
        };

        s3.headObject(params, function(err, data) {
          if (err) return callback(err); // an error occurred
          else {
            fnConfig.submodules[key].versionId = data.VersionId;
            if (data.Metadata && data.Metadata.commit_id) {
              fnConfig.submodules[key].lastCommitId = data.Metadata.commit_id;
            }
            callback(null);
          }
        });
      },
      function(err, results) {
        if (err) return resultCallback(err);
        resultCallback(null, fnConfig);
      });
  }

  function beginDeployment(command, targetEnvConfig, callback) {
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
      params.Comment = targetEnvConfig.commandSpec.recipes.join(',');
    }

    opsworks.createDeployment(params, function(err, data) {
      if (err) {
        console.log('Deployment to OpsWorks failed. {%s}', err);
        return callback(err);
      }
      console.log('OpsWorks deployment %s triggered for command %s. ', data.DeploymentId, command);
      utils.publishMonitorMessage(config.monitoringTopicArn, 'monitorDeployment', command, data.DeploymentId, function(err, result) {
        if (err) return callback(err);
        callback(null, data);
      });
    });
  }

  var updatedConfig = config;

  async.waterfall([
      function(callback) {
        dbHandler.acquireLock(jobData.config.appName, 'handleDeployment', callback);
      },
      function(callback) {
        locked = true;

        getArtifactMetadata(jobData, function(err, result) {
          if (err) return callback(err);
          jobData.config = result;
          updatedConfig = result;
          callback(null, jobData);
        });
      },
      function(jobData, callback) {
        validateDeploymentStatus(jobData, message.command, callback);
      },
      function(data, callback) {
        jobData.lastVersionId = data.item_version;
        dbHandler.updateDeploymentStatus(jobData.config.appName, utils.buildPipelineStatus(message.command, contextHolder.STATUS_INPROGRESS), jobData.lastVersionId, contextHolder.STATUS_RUNNING, jobData.deploymentId, message.command, callback);
      },
      function(callback) {
        jobData.dbUpdated = true;
        jobData.lastVersionId++;
        targetEnvSetHelper(jobData, message, context, callback);
      },
      function(targetEnvConfig, callback) {
        beginDeployment(message.command, targetEnvConfig, callback);
      },
      function(data, callback) {
        jobData.deploymentId = data.DeploymentId;
        dbHandler.updateDeploymentStatus(jobData.config.appName, utils.buildPipelineStatus(message.command, contextHolder.STATUS_INPROGRESS), jobData.lastVersionId, contextHolder.STATUS_RUNNING, data.DeploymentId, message.command, callback);
      },
      function(callback) {
        dbHandler.releaseLock(jobData.config.appName, 'handleDeployment', callback);
        locked = false;
      }
    ],
    function(err, results) {
      if (err) {
        console.log('error', err);
        if (jobData && jobData.dbUpdated) {
          dbHandler.updateDeploymentStatus(jobData.config.appName, utils.buildPipelineStatus(message.command, contextHolder.STATUS_FAILED), jobData.lastVersionId, contextHolder.STATUS_NOTRUNNING, jobData.deploymentId, message.command, utils.noopCallback);
        }
      }
      if (locked) {
        dbHandler.releaseLock(jobData.config.appName, 'handleDeployment', function(errLock, result) {
          if (err) {
            if (err.subtype && err.subtype == 'skip_deployment') {
              context.succeed();
              return;
            }
            console.log('handleDeployment: Marking a failure. This may cause retries of the operation %s , err %s',message.command, err);
            context.fail(err);
            return;
          }
        });
      } else {
        context.succeed();
      }
    }
  );
};
