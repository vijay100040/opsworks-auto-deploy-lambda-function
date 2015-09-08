var async = require("async");
var contextHolder = require("./app_context_holder.js");
var opsworks = contextHolder.opsworks;
var sns = contextHolder.sns;
var dbHandler = require("./db_handler.js");
var utils = require("./utils.js");
var moment = require("moment");
var logger = require("winston");

module.exports = function (message, config, context) {
	var deployID = message.deploymentId;
	var command = message.command;
	var messageSource = message.source;
	var locked = false;
	var jobData = {};
	jobData.config = config;
	jobData.dbUpdated = false;
	jobData.deploymentId = "NEW";

	if (!messageSource) {
		messageSource = "lambda";
	}

	var minsElapsed = Math.ceil((Date.now() - config.messageSent) / 60000);

	function notifyIfRequired(jobData, pipelineStatus, forceNotify, callback) {
		if (forceNotify || utils.isNotificationRequired(contextHolder.NOTIFY_STATUSES_REGEXP, pipelineStatus)) {
			// This status requires a notification, publish to notification topic.
			// Any subscribers will be notified.
			// We only support a JSON message now.
			var notificationMessage = JSON.stringify({
				deploymentId: jobData.deploymentId,
				command: jobData.command,
				status: pipelineStatus
			});

			var params = {
				Message: notificationMessage,
				Subject: "OpsWorks Deployment Notification",
				TargetArn: jobData.config.notificationTopicArn
			};
			logger.debug("Notifying message to notification topic %s", jobData.config.notificationTopicArn);

			sns.publish(params, function (err, data) {
				if (err) {
					logger.error(err);
					return callback(err);
				}
				callback(null, data);
			});
		}
		callback();
	}

	function processMonitoringStatus(command, deployID, lastDeploymentData, callback) {
		var params = {
			DeploymentIds: [deployID]
		};
		opsworks.describeDeployments(params, function (err, data) {
			if (err) return callback(err);

			if (data.Deployments.length > 0) {
				var commandStatus = data.Deployments[0].Status;
				var deploymentStatus = "";
				var pipelineStatus = contextHolder.STATUS_NOTRUNNING;

				var commandIndex = contextHolder.COMMANDS_IN_PIPELINE.indexOf(command);
				var nextCommand = "";
				var forceNotify = false;

				switch (commandStatus) {
				case "successful":
					var nextCommandIndex = commandIndex + 1;
					if (nextCommandIndex < contextHolder.COMMANDS_IN_PIPELINE.length) {
						// There are still other commands to execute, mark pipeline as inprogress
						pipelineStatus = contextHolder.STATUS_RUNNING;

						nextCommand = contextHolder.COMMANDS_IN_PIPELINE[nextCommandIndex];
					} else if (nextCommandIndex === contextHolder.COMMANDS_IN_PIPELINE.length) {
						// Last command. If there is any pending deployment, we'll trigger a new deployment
						if(lastDeploymentData.deployment_queued_flag) {
							nextCommand = contextHolder.COMMANDS_IN_PIPELINE[0];
						}
					}
					break;
				case "failed":
					break;
				default:
					commandStatus = contextHolder.STATUS_INPROGRESS;
					if (minsElapsed > config.deploymentTimeout) {
						commandStatus = contextHolder.STATUS_FAILED;
						logger.debug("Opsworks deployment %s timed out after %s minutes", deployID, minsElapsed);
					} else {
						// Marking this request context as fail would cause SNS to try and redeliver this again after a delay
						var waitingError = new Error("Waiting for command '" + command + "' with ID " + deployID + " to complete. elapsed :" + minsElapsed);
						waitingError.subtype = "waiting";

						return callback(waitingError);
					}
				}
				deploymentStatus = utils.buildPipelineStatus(command, commandStatus);

				if (commandStatus === contextHolder.STATUS_FAILED) {
					var currentCommandSpec = utils.findByCommand(contextHolder.COMMANDS, command);
					if (currentCommandSpec.onfailCommand == contextHolder.COMMAND_HALT_PIPELINE) {
						// A command failed, and pipeline HALT was requested.
						// This can only be manually changed in the DB at this time.
						pipelineStatus = contextHolder.STATUS_HALTED;
						forceNotify = true;
						logger.debug("Command %s failed. Pipeline halted. To resume, update the pipeline_status to \"NOT_RUNNING\"", command);
					} else {
						nextCommand = currentCommandSpec.onfailCommand;
						pipelineStatus = contextHolder.STATUS_NOTRUNNING;
						logger.debug("Command %s failed. Will call onfailCommand if it exists", command);
					}
				}

				async.waterfall([
						function (callback) {
							var updateParams = {};
							updateParams.deploymentStatus  = deploymentStatus;
							updateParams.currentVersion  = lastDeploymentData.item_version;
							updateParams.pipelineStatus = pipelineStatus;
							updateParams.deploymentId = deployID;
							updateParams.lastCommand = command;

							dbHandler.updateDeploymentStatus(config.appName, updateParams,  callback);
						},
						function (callback) {
							notifyIfRequired(jobData, deploymentStatus, forceNotify, function () {
								callback();
							});
						},
						function (callback) {
							if (nextCommand) {
								logger.debug("Command %s completed with status %s. Triggering command %s", command, commandStatus, nextCommand);
								utils.publishMonitorMessage(config.handlerTopicArn, "handleDeployment", nextCommand, "NA", function () {
									callback();
								});
							} else {
								callback();
							}
						}
					],
					callback
				);

			} else {
				callback();
			}
		});
	}

	async.waterfall([
			function (callback) {
				dbHandler.acquireLock(config.appName, "monitorDeployment", callback);
			},
			function (callback) {
				locked = true;
				dbHandler.getDeploymentStatus(config.appName, function (err, data) {
					if (data.pipeline_status === contextHolder.STATUS_HALTED || data.deployment_id === "NEW") {
						return callback();
					}
					if (data.pipeline_status === contextHolder.STATUS_NOTRUNNING) {
						var deploymentStatus = utils.buildPipelineStatus(contextHolder.COMMANDS_IN_PIPELINE[contextHolder.COMMANDS_IN_PIPELINE.length-1], contextHolder.STATUS_SUCCESSFUL);

						if(!(data.deployment_queued_flag && data.deployment_status === deploymentStatus)) {
							return callback();
						}
					}
					var MIN_WAIT_SECONDS = 20;
					if (moment().diff(moment(data.last_updated_datetime), "seconds") <= MIN_WAIT_SECONDS) {
						logger.debug("The pipeline status was updated less than %s seconds ago. ", MIN_WAIT_SECONDS);
						return callback();
					}

					// We force monitor only the last deployment_id / command to ensure integrity
					deployID = data.last_deployment_id;
					command = data.last_command;
					jobData.command = message.command;
					jobData.deploymentId = message.deploymentId;

					// There was no command ID available. Try processing last deployment command from database
					logger.debug("Processing monitoring message for command %s with id %s", command, deployID);
					processMonitoringStatus(command, deployID, data, callback);
				});
			},
			function (callback) {
				dbHandler.releaseLock(config.appName, "monitorDeployment", callback);
				locked = false;
			}
		],
		function (err) {
			if (err) {
				logger.error(err.message);
			}

			if (locked) {
				dbHandler.releaseLock(config.appName, "monitorDeployment", function () {
					context.succeed();
				});
			} else {
				context.succeed();
			}
		});
};
