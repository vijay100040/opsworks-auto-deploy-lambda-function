var helper = require("./helper.js");
var logger = helper.logger;
var opsworks = helper.opsworks;
var async = require("async");
var sns = helper.sns;
var moment = require("moment");
var dbHandler = require("./db_handler.js");

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
		if (forceNotify || helper.isNotificationRequired(helper.NOTIFY_STATUSES_REGEXP, pipelineStatus)) {
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
				var pipelineStatus = helper.STATUS_NOTRUNNING;

				var commandIndex = helper.DEPLOYMENT_COMMAND_SEQ.indexOf(command);
				var nextCommand = "";
				var forceNotify = false;

				switch (commandStatus) {
				case helper.STATUS_SUCCESSFUL:
					var nextCommandIndex = commandIndex + 1;
					if (nextCommandIndex < helper.DEPLOYMENT_COMMAND_SEQ.length) {
						// There are still other commands to execute, mark pipeline as inprogress
						pipelineStatus = helper.STATUS_RUNNING;

						nextCommand = helper.DEPLOYMENT_COMMAND_SEQ[nextCommandIndex];
					} else if (nextCommandIndex === helper.DEPLOYMENT_COMMAND_SEQ.length) {
						// Last command. If there is any pending deployment, we'll trigger a new deployment
						if(lastDeploymentData.deployment_queued_flag) {
							nextCommand = helper.DEPLOYMENT_COMMAND_SEQ[0];
						}
					}
					break;
				case helper.STATUS_FAILED:
					break;
				default:
					commandStatus = helper.STATUS_INPROGRESS;
					if (minsElapsed > config.deploymentTimeout) {
						commandStatus = helper.STATUS_FAILED;
						logger.warn("Opsworks deployment %s timed out after %s minutes", deployID, minsElapsed);
					} else {
						// Marking this request context as fail would cause SNS to try and redeliver this again after a delay
						var waitingError = new Error("Waiting for command '" + command + "' with ID " + deployID + " to complete. elapsed :" + minsElapsed);
						waitingError.subtype = "waiting";

						return callback(waitingError);
					}
				}
				deploymentStatus = helper.buildPipelineStatus(command, commandStatus);
				var updateParams = {};

				if (commandStatus === helper.STATUS_FAILED) {
					updateParams.failedDeploymentsCountIncrement = 1;
					updateParams.deploymentEndDatetime = Date.now();

					var currentCommandSpec = helper.findByCommand(helper.COMMANDS, command);
					if (currentCommandSpec.onfailCommand == helper.COMMAND_HALT_PIPELINE) {
						// A command failed, and pipeline HALT was requested.
						// This can only be manually changed in the DB at this time.
						pipelineStatus = helper.STATUS_HALTED;
						forceNotify = true;
						logger.info("Command %s failed. Pipeline halted. To resume, update the pipeline_status to \"NOT_RUNNING\"", command);
					} else {
						nextCommand = currentCommandSpec.onfailCommand;
						pipelineStatus = helper.STATUS_NOTRUNNING;
						logger.info("Command %s failed. Will call onfailCommand if it exists", command);
					}
				}

				async.waterfall([
						function (callback) {
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
								helper.publishMonitorMessage(config.handlerTopicArn, "handleDeployment", nextCommand, "NA", function () {
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
					if (data.pipeline_status === helper.STATUS_HALTED || data.deployment_id === "NEW") {
						return callback();
					}
					if (data.pipeline_status === helper.STATUS_NOTRUNNING) {
						var deploymentStatus = helper.buildPipelineStatus(helper.DEPLOYMENT_COMMAND_SEQ[helper.DEPLOYMENT_COMMAND_SEQ.length-1], helper.STATUS_SUCCESSFUL);

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
			if (err && !(err.subtype && err.subtype ==="waiting")) {
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
