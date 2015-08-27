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
  };

  dynamodb.getItem(params, function(err, data) {
    if (err) {
      return callback(err);
    }
    if (!data) {
      return callback(new Error("getDeploymentStatus: Could not find status record. Cowardly refusing to proceed any further"));
    }
    callback(null, data.Item);
  });
}

function updateDeploymentStatus(appName, deploymentStatus, currentVersion, pipelineStatus, lastDeploymentId, callback) {
  console.log('Updating status for deployment, v: %s ds:%s ps:%s' ,currentVersion, deploymentStatus, pipelineStatus);
  params = {};
  params.TableName = DEPLOYMENT_TABLE;
  params.Key = {"app_name": appName};

  params.UpdateExpression = "set deployment_status = :deploymentStatus, item_version = :newItemVersion, pipeline_status = :pipelineStatus, last_updated_datetime = :updatedDateTime, last_deployment_id = :lastDeploymentId";

  params.ConditionExpression = "item_version = :itemVersion";
  params.ExpressionAttributeValues = {
    ":deploymentStatus": deploymentStatus,
    ":itemVersion": currentVersion,
    ":newItemVersion": currentVersion + 1,
    ":pipelineStatus": pipelineStatus,
    ":updatedDateTime" : Date.now(),
    ":lastDeploymentId" : lastDeploymentId
  };

  dynamodb.updateItem(params, function(err, data) {
    if (err) {
      console.log('Had a problem updating deployment progress %s', err);
      return callback(err);
    }
    callback();
  });
}

module.exports = {
  getDeploymentStatus: getDeploymentStatus,
  updateDeploymentStatus: updateDeploymentStatus
};
