var AWS = require('aws-sdk');
var async = require('async');
var contextHolder = require('./app_context_holder.js');
var dynamodb = contextHolder.dynamo;
var DEPLOYMENT_TABLE = 'deployments';

function getDeploymentStatus(appName, callback) {
  params = {};
  params.TableName = DEPLOYMENT_TABLE;
  params.Key = {
    "app_name": appName
  }

  dynamodb.getItem(params, function(err, data) {
    if (err) {
      return callback(err);
    }
    if (!data) {
      return callback(new Error("getDeploymentStatus: Could not find status record. Cowardly refusing to proceed any further"));
    }
    callback(null, data.Item);
  });
};

function updateDeploymentStatus(appName, deploymentStatus, currentData, pipelineStatus, callback) {
  console.log('Updating Progress for deployment, v:' + currentData.item_version);
  params = {};
  params.TableName = DEPLOYMENT_TABLE;
  params.Key = {
    "app_name": appName
  }

  params.UpdateExpression = "set deployment_status = :deploymentStatus, item_version = :newItemVersion, pipeline_status = :pipelineStatus";

  params.ConditionExpression = "item_version = :itemVersion";
  params.ExpressionAttributeValues = {
    ":deploymentStatus": deploymentStatus,
    ":itemVersion": currentData.item_version,
    ":newItemVersion": currentData.item_version + 1,
    ":pipelineStatus": pipelineStatus
  };

  dynamodb.updateItem(params, function(err, data) {
    if (err) {
      console.log('Had a problem updating deployment progress %s', err);
      return callback(err);
    }
    callback();
  });
};

module.exports = {
  getDeploymentStatus: getDeploymentStatus,
  updateDeploymentStatus: updateDeploymentStatus
}
