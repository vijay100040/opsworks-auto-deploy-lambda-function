var AWS = require('aws-sdk');

AWS.config.update({
  region: 'us-east-1',
  apiVersions: {
    s3: '2006-03-01'
  },
  S3Config: {
    UseSignatureVersion4: true
  }
});
var exp = {};

exp.opsworks = new AWS.OpsWorks();
exp.s3 = new AWS.S3({
  signatureVersion: 'v4'
});
exp.sns = new AWS.SNS();
var doc = require('dynamodb-doc');

exp.dynamo = new doc.DynamoDB();

exp.COMMANDS = [{
  "command": "deploy",
  "recipes": [],
  "targetLayerTypes": ["load-balancer", "app_frontend", "app_backend"],
  "onfail_command": ""
}, {
  "command": "test_staging",
  "recipes": ["blue_green_deploy::run_tests"],
  "targetLayerTypes": ["load-balancer"],
  "onfail_command": ""
}, {
  "command": "prepare_stg_for_prod",
  "recipes": ["blue_green_deploy::prepare_stg_for_prod"],
  "targetLayerTypes": ["app_frontend", "app_backend"],
  "onfail_command": ""
}, {
  "command": "switch_to_prod",
  "recipes": ["blue_green_deploy::switch_to_prod"],
  "targetLayerTypes": ["load-balancer"],
  "onfail_command": "stop_staging"
}, {
  "command": "cleanup",
  "recipes": ["blue_green_deploy::kill_old_containers"],
  "targetLayerTypes": ["app_frontend", "app_backend"],
  "onfail_command": ""
}];

module.exports = exp;
