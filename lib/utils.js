var contextHolder = require('./app_context_holder.js');

var printCallback = function(err, data) {
    if (err) {
        console.log(err, err.stack);
    } else {
        console.log('data : {%s}, jsonData : {%s}', data, JSON.stringify(data));
    }
}

var findByCommand = function (source, command) {
    return source.filter(function( obj ) {
        return obj.command === command;
    })[ 0 ];
}

var buildPipelineStatus  = function (command, status) {
  return [command, status].join('__');
}

var isNotificationRequired = function (notificationPatterns, pipelineStatus) {
  return new RegExp(notificationPatterns.join('|')).test(pipelineStatus);
}

var publishMonitorMessage = function(topicArn, action , command, deploymentId, callback) {
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
  buildPipelineStatus: buildPipelineStatus
}
