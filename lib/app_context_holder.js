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

module.exports = exp;
