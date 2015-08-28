var contextHolder = require('./app_context_holder.js');

function printCallback(err, data) {
  if (err) {
    console.log(err, err.stack);
  } else {
    if(data) {
      console.log('data : {%s}, jsonData : {%s}', data, JSON.stringify(data));
    }
  }
}
function noopCallback(err, data) {
  // Do nothing. 
}

function findByCommand(source, command) {
  return source.filter(function(obj) {
    return obj.command === command;
  })[0];
}
function findByModuleName(source, moduleName) {
  return source.filter(function(obj) {
    return obj.module === moduleName;
  })[0];
}

function buildPipelineStatus(command, status) {
  return [command, status].join('__');
}

function isNotificationRequired(notificationPatterns, pipelineStatus) {
  return new RegExp(notificationPatterns.join('|')).test(pipelineStatus);
}

function publishMonitorMessage(topicArn, action, command, deploymentId, callback) {
  var notificationMessage = JSON.stringify({
    action: action,
    deploymentId: deploymentId,
    command: command
  });

  var params = {
    Message: notificationMessage,
    Subject: 'Monitor OpsWorks Deployment',
    TargetArn: topicArn
  };
  contextHolder.sns.publish(params, callback);
}
module.exports = {
  isNotificationRequired: isNotificationRequired,
  findByCommand: findByCommand,
  publishMonitorMessage: publishMonitorMessage,
  buildPipelineStatus: buildPipelineStatus,
  printCallback: printCallback,
  noopCallback: noopCallback,
  findByModuleName:findByModuleName
};
