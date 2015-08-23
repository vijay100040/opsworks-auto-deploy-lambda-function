# blue-green-deployer

This repository has the Lambda function for OpsWorks deployment to support Blue / Green Deployments.

While OpsWorks supports deploying an application to a Layer or a set of instances, the Blue / Green deployment strategy suggests setting up two similar environments for production, with one receiving production traffic, and the other used to deploy / test and switch to.

We'll implement this by supporting a process where the deployments are triggered from a file upload on S3, all submodules in the environment (frontend, backend) are deployed together and switched together.

# How does it work?
  * An versioned S3 bucket is configured to trigger a SNS notification. Whenever this notification is sent, this lambda function is called by AWS.
  * The lambda function checks to confirm that there is no other deployment currently in progress.
  * If there are no deployments in progress, the function triggers a new opsworks deployment
  * It also sends a monitoring notification message to a separate SNS topic. This topic has it's delivery policy setup in such a way that until the lambda function marks it's execution successful, it will keep calling the function (upto 30 times, every 15 to 30 seconds). This acts as a mechanism to workaround lambda's limitation of 60 seconds execution time limit.
  * The monitoring function would mark the status as complete / failed / timedout for the specific command that was executed. The commands are setup to handle the blue / green deployment needs.
  * When a command is completed successfully, the monitoring function would also trigger next stage in the pipeline.
# Configuration
The function is configured with a .env file at the root of function. See .env.example for reference. The file needs to be changed and copied over with the name '.env'
# Build & Deploy
The function can be run locally with lambda_invoke and deployed to AWS using lambda_deploy. Make sure that the lambda function ARN is configured in the Gruntfile.js

# Acknowledgements
Some parts of this implementation were adapted from https://github.com/Tim-B/codepipeline-opsworks-deployer, especially the lovely publish to monitoring topic with retry idea.
