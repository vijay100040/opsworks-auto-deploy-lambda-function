var async = require('async');
//var jobHelper = require('./job_functions.js');
var contextHolder = require('./app_context_holder.js');
var opsworks = contextHolder.opsworks;
var dbHandler = require('./db_handler.js');

module.exports = function (message, config, context) {

    var deployID = message.deploymentId;
    var minsElapsed = Math.ceil((Date.now() - config.messageSent) / 60000);

    var getDeployStatus = function (deployID, callback) {
        var params = {
            DeploymentIds: [deployID]
        };
        opsworks.describeDeployments(params, function (err, data) {
            if (err) {
                console.log('Could not check deploy status.', err);
                return callback(err);
            }

            if (data.Deployments.length > 0) {
                var deployStatus = data.Deployments[0].Status;
                var continueWaiting = false;
                var pipelineStatus = '';

                switch (deployStatus) {
                    case 'successful':
                        pipelineStatus = 'deploy_complete';
                        console.log('Deploy succeeded');
                        break;
                    case 'failed':
                        pipelineStatus = 'deploy_failed';
                        console.log('Deploy failed');
                        break;
                    default:
                        pipelineStatus = 'deploy_inprogress';
                        if(minsElapsed > 9) {
                            /*jobHelper.markFail(message.Job, 'OpsWorks deploy timed out', function() {
                                context.succeed("OpsWorks deploy timed out");
                            });*/
                            pipelineStatus = 'deploy_timedout';
                            console.log('Opsworks deployment %s timed out after 9 minutes', deployID);
                        } else {
                            continueWaiting = true;
                            console.log('Deploy still running, elapsed: ' + minsElapsed);
                            context.fail("Still waiting");
                        }
                }
                if(continueWaiting) {
                  context.fail("Still waiting for deployment "+deployID+" to complete" );
                  return;
                }
                async.waterfall([
                    function (callback) {
                       dbHandler.getDeploymentStatus(config.appName, function(err, data) {
                         if(err) {
                           callback(err);
                           return;
                         }
                         callback(null, data.item_version);
                       });
                    },
                    function (itemVersion, callback) {
                      dbHandler.updateDeploymentStatus(config.appName, pipelineStatus, itemVersion, callback);
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

            } else {
                callback();
            }
        });
    }

    getDeployStatus(deployID, function () {

        //context.succeed("Status updated");
    });

}
