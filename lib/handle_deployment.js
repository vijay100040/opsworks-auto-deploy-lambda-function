var AWS = require('aws-sdk');
var async = require('async');
var contextHolder = require('./app_context_holder.js');
var dbHandler = require('./db_handler.js');
var targetEnvSetHelper = require('./target_envset_helper.js');

var DEPLOY_STATUS_INPROGRESS = "deploy_inprogress";
var PROGRESS_STATUSES = ['deploy_inprogress', 'testing_inprogress', 'switching_inprogress'];
module.exports = function (message, config, context) {
    var s3 = contextHolder.s3;
    var opsworks = contextHolder.opsworks;
    var sns = contextHolder.sns;
    var dynamodb = contextHolder.dynamo;
    var deploymentId = Date.now().toString();


    var checkDeploymentStatus = function(callback) {
      dbHandler.getDeploymentStatus(config.appName, function(err, data) {
        if(err) {
            return callback(err);
        }

        deploymentStatus = data.deployment_status;

        if (PROGRESS_STATUSES.indexOf(deploymentStatus) >= 0 && !process.env.DEBUG) {
          console.log('A deployment is already in progress. Skipping deployment.', deploymentStatus);
          callback(new Error("A deployment is already in progress. Skipping deployment. "));
          return;
        }

        callback(null, data.item_version);
      });
    }

    var publishMonitorMessage = function(config, deployment, callback) {
            var message = JSON.stringify({
                action: 'monitorDeployment',
                deploymentId: deployment.DeploymentId,
            });

            var params = {
                Message: message,
                Subject: 'Monitor OpsWorks Deployment',
                TargetArn: config.monitoringTopicArn
            };
            sns.publish(params, callback});
    }

    var beginDeployment =  function(command, targetEnvConfig, callback) {
      var params = {};
      params.Command = { Name : command };
      params.StackId = config.opsWorksStackId;
      params.CustomJson = JSON.stringify(targetEnvConfig.customJson);
      params.InstanceIds =  targetEnvConfig.targetEnvInstanceIds;
      if(command == "deploy") {
        params.AppId =  config.opsWorksAppId;
      } else {
        params.Args = {"recipes":[command]};
      }

        opsworks.createDeployment(params, function(err, data) {
                  if(err) {
                      console.log('Deployment to OpsWorks failed. {%s}', err);
                      return callback(err);
                  }
                  console.log('OpsWorks deployment %s triggered.', data.DeploymentId);
                  publishMonitorMessage(config, data, callback);
        });
    };

    async.waterfall([
        function (callback) {
           checkDeploymentStatus(callback);
        },
        function (itemVersion, callback) {
          dbHandler.updateDeploymentStatus(config.appName, DEPLOY_STATUS_INPROGRESS, itemVersion, callback);
        },
        function(callback) {
          targetEnvSetHelper(message, config, context, callback);
        },
        function (targetEnvConfig, callback) {
          beginDeployment(message.command, targetEnvConfig, callback);
        }
      ],
        function (err, results) {
          if(err) {
            console.log('error', err);
            context.fail(err);
            return;
          }
          context.succeed();
        }
    );
}
