var helper = require("./helper.js");
var logger = helper.logger;
var async = require("async");
var moment = require("moment");
var dynamodb = helper.dynamo;
var DEPLOYMENT_TABLE = "deployments";
var ACTIVITY_TABLE = "deployment_activity";
var LOCK_EXPIRY_TIME_SECONDS = 15;
var LOCK_WAIT_TIME_SECONDS = 1;

function getDeploymentStatus(appName, callback) {
  var params = {};
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

function updateLock(appName, lockType, lockName, callback) {
  var params = {};
  params.TableName = DEPLOYMENT_TABLE;
  params.Key = {
    "app_name": appName
  };
  if (lockType != "acquire" && lockType != "release") {
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
    updateParams.Key = {
      "app_name": appName
    };
    var lockExpiryDateTime = moment().subtract(LOCK_EXPIRY_TIME_SECONDS, "seconds").valueOf();

    var lockValue = 1;
    var expectedLockValue = 0;
    if (lockType === "release") {
      lockValue = 0;
      expectedLockValue = 1;
      updateParams.ConditionExpression = "item_version = :itemVersion AND (locked = :expectedLockValue OR lock_datetime <= :lockExpiryDateTime)";
    } else {
      updateParams.ConditionExpression = "item_version = :itemVersion AND (locked = :expectedLockValue OR lock_datetime <= :lockExpiryDateTime)";
    }

    updateParams.UpdateExpression = "set locked  = :lockValue, item_version = :newItemVersion, lock_datetime = :updatedDateTime";

    updateParams.ExpressionAttributeValues = {
      ":itemVersion": itemData.item_version,
      ":newItemVersion": newVersion,
      ":updatedDateTime": Date.now(),
      ":lockValue": lockValue,
      ":expectedLockValue": expectedLockValue,
      ":lockExpiryDateTime": lockExpiryDateTime
    };

    dynamodb.updateItem(updateParams, function(err) {
      if (err) {
        return callback(new Error("Could not update lock " + lockName + " for " + lockType));
      }
      return callback();
    });
  });
}

function updateLockWithRetry(appName, lockType, lockName, callback) {
  var tryCount = 0;
  var updateTask = function(taskCallback) {
    tryCount++;
    updateLock(appName, lockType, lockName, taskCallback);
  };
  async.retry({
    interval: LOCK_WAIT_TIME_SECONDS
  }, updateTask, function(err) {

    if (err) {
      logger.debug("failed to updateLock: n:%s, o:%s tries:%s", lockName, lockType, tryCount);
      return callback(err);
    } else {
      if (tryCount > 1) {
        logger.debug("updateLock: n:%s, o:%s tries:%s", lockName, lockType, tryCount);
      }
      return callback();
    }
  });
}

function acquireLock(appName, lockName, callback) {
  updateLockWithRetry(appName, "acquire", lockName, callback);
}

function releaseLock(appName, lockName, callback) {
  updateLockWithRetry(appName, "release", lockName, callback);
}

function updateDeploymentStatus(appName, options, callback) {
  // logger.debug("Updating status v: %s, v1:%s, ds:%s ps:%s c:", currentVersion, currentVersion + 1, deploymentStatus, pipelineStatus, lastCommand);
  var params = {};
  params.TableName = DEPLOYMENT_TABLE;
  params.Key = {
    "app_name": appName
  };

  var paramsMapping = [{
    "name": "deploymentStatus",
    "column": "deployment_status"
  }, {
    "name": "newItemVersion",
    "column": "item_version"
  }, {
    "name": "pipelineStatus",
    "column": "pipeline_status"
  }, {
    "name": "lastDeploymentId",
    "column": "last_deployment_id"
  }, {
    "name": "lastCommand",
    "column": "last_command"
  }, {
    "name": "deploymentQueuedFlag",
    "column": "deployment_queued_flag"
	}, {
    "name": "deploymentBeginDatetime",
    "column": "deployment_begin_datetime"
	}, {
    "name": "deploymentEndDatetime",
    "column": "deployment_end_datetime"
  }, {
    "name": "totalDeploymentsCountIncrement",
    "column": "total_deployments_count",
    "isCounter": true
  }, {
    "name": "failedDeploymentsCountIncrement",
    "column": "failed_deployments_count",
    "isCounter": true
  }, {
    "name": "pipelineId",
    "column": "pipeline_id"
  }];


  params.ExpressionAttributeValues = {
    ":itemVersion": options.currentVersion,
    ":newItemVersion": options.currentVersion + 1,
    ":updatedDateTime": Date.now()
  };

  var updateExpressions = [];
  paramsMapping.forEach(function(paramItem) {
    if (options.hasOwnProperty(paramItem.name) && typeof options[paramItem.name] != "undefined") {
      if (paramItem.isCounter) {
        updateExpressions.push(paramItem.column + " = " + paramItem.column + " +  :" + paramItem.name);
      } else {
        updateExpressions.push(paramItem.column + " = :" + paramItem.name);
      }
      var paramItemKey = ":" + paramItem.name;

      params.ExpressionAttributeValues[paramItemKey] = options[paramItem.name];
    }
  });

  params.UpdateExpression = "set item_version = :newItemVersion, last_updated_datetime = :updatedDateTime, " + updateExpressions.join(",");
  params.ConditionExpression = "item_version = :itemVersion";

  dynamodb.updateItem(params, function(err) {
    if (err) {
      logger.debug("Had a problem updating deployment progress %s", err);
      return callback(err);
    }
    callback();
  });
}

function insertActivityData(options, callback) {
  var item = {};
  item.deployment_id = options.deploymentId;
  item.pipeline_id = options.pipelineId;
  item.pipeline_status=options.pipelineStatus
  item.deployment_date_time=options.deploymentBeginDatetime;
  item.deployment_source = options.deploymentSource;
  item.message_command = options.message;

  dynamodb.putItem({TableName: ACTIVITY_TABLE, Item: item}, function(err, data){
    if (err) {
    console.log(err); // an error occurred
    return callback(err);
    } else {
    console.log(data); // successful response
    callback();
    }
});
}

module.exports = {
  getDeploymentStatus: getDeploymentStatus,
  updateDeploymentStatus: updateDeploymentStatus,
  acquireLock: acquireLock,
  releaseLock: releaseLock,
  insertActivityData: insertActivityData
};
