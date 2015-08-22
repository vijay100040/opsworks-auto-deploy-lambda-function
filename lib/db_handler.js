var AWS = require('aws-sdk');
var async = require('async');
var contextHolder = require('./app_context_holder.js');
var dynamodb = contextHolder.dynamo;
var DEPLOYMENT_TABLE = 'deployments';

var getDeploymentStatus = function(appName, callback) {
  params = {};
  params.TableName = DEPLOYMENT_TABLE;
  params.Key = {"app_name" : appName}

  dynamodb.getItem(params,  function(err, data) {
      if(err) {
          return callback(err);
      }
      if (!data) {
        return callback(new Error("getDeploymentStatus: Could not find status record. Cowardly refusing to proceed any further"));
      }
      callback(null, data.Item);
  });
};

var updateDeploymentStatus = function(appName, deploymentStatus, itemVersion, callback) {
  console.log('Updating Progress for deployment, v:'+itemVersion);
  params = {};
  params.TableName = DEPLOYMENT_TABLE;
  params.Key = {"app_name" : appName}

  params.UpdateExpression = "set deployment_status = :deploymentStatus, item_version = :newItemVersion";

  params.ConditionExpression = "item_version = :itemVersion";
  params.ExpressionAttributeValues = {":deploymentStatus" : deploymentStatus,
                                      ":itemVersion" : itemVersion,
                                      ":newItemVersion" : itemVersion + 1
                                      };

  dynamodb.updateItem(params, function(err, data) {
      if(err) {
          console.log('Had a problem updating deployment progress %s', err);
          return callback(err);
      }
      callback();
    });
};

module.exports = {
    getDeploymentStatus : getDeploymentStatus,
    updateDeploymentStatus : updateDeploymentStatus
}
