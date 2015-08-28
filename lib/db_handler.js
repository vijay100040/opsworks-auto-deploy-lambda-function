var AWS = require('aws-sdk');
var async = require('async');
var moment = require('moment');
var contextHolder = require('./app_context_holder.js');
var dynamodb = contextHolder.dynamo;
var DEPLOYMENT_TABLE = 'deployments';
var LOCK_EXPIRY_TIME_SECONDS = 100;

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

function updateLock(appName, lockType, callback) {
  params = {};
  params.TableName = DEPLOYMENT_TABLE;
  params.Key = {
    "app_name": appName
  };
  if(lockType != 'acquire' && lockType != 'release') {
    return callback(new Error("Invalid value for parameter lockType"));
  }

  dynamodb.getItem(params, function(err, result) {
    if (err) {
      return callback(err);
    }
    if (!result) {
      return callback(new Error(lockType + "Lock: Could not find status record. Cowardly refusing to proceed any further"));
    }
    var itemData = result.Item;
    var newVersion = itemData.item_version + 1;

    var updateParams = {};
    updateParams.TableName = DEPLOYMENT_TABLE;
    updateParams.Key = {"app_name": appName};
    var lockValue = 1;
    var expectedLockValue = 0;
    var lockExpiryDateTime = moment().subtract(LOCK_EXPIRY_TIME_SECONDS,'seconds').valueOf();
    if(lockType === 'release') {
      lockValue = 0;
      expectedLockValue = 1;
    }

    updateParams.UpdateExpression = "set locked  = :lockValue, item_version = :newItemVersion, lock_datetime = :updatedDateTime";

    updateParams.ConditionExpression = "item_version = :itemVersion AND (locked = :expectedLockValue OR lock_datetime <= :lockExpiryDateTime)";
    updateParams.ExpressionAttributeValues = {
      ":itemVersion": itemData.item_version,
      ":newItemVersion": newVersion,
      ":updatedDateTime" : Date.now(),
      ":lockValue" : lockValue,
      ":expectedLockValue" : expectedLockValue,
      ":lockExpiryDateTime" : lockExpiryDateTime
    };
    console.log("updateLock: o: %s , msLock:%s v:%s lv:%s", lockType, lockExpiryDateTime , newVersion, lockValue);

    dynamodb.updateItem(updateParams, function(err, data) {
      if (err) {
        return callback(new Error('Could not update lock for '+lockType));
      }
      return callback();
    });
  });
}


function acquireLock(appName, callback) {
  return updateLock(appName,'acquire', callback);
}

function releaseLock(appName, callback) {
  return updateLock(appName,'release', callback);
}

function updateDeploymentStatus(appName, deploymentStatus, currentVersion, pipelineStatus, lastDeploymentId, lastCommand, callback) {
  console.log('Updating status v: %s, v1:%s, ds:%s ps:%s c:' ,currentVersion, currentVersion+1, deploymentStatus, pipelineStatus, lastCommand);
  params = {};
  params.TableName = DEPLOYMENT_TABLE;
  params.Key = {"app_name": appName};

  params.UpdateExpression = "set deployment_status = :deploymentStatus, item_version = :newItemVersion, pipeline_status = :pipelineStatus, last_updated_datetime = :updatedDateTime, last_deployment_id = :lastDeploymentId, last_command = :lastCommand";

  params.ConditionExpression = "item_version = :itemVersion";
  params.ExpressionAttributeValues = {
    ":deploymentStatus": deploymentStatus,
    ":itemVersion": currentVersion,
    ":newItemVersion": currentVersion + 1,
    ":pipelineStatus": pipelineStatus,
    ":updatedDateTime" : Date.now(),
    ":lastDeploymentId" : lastDeploymentId,
    ":lastCommand" : lastCommand
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
  updateDeploymentStatus: updateDeploymentStatus,
  acquireLock : acquireLock,
  releaseLock : releaseLock
};
