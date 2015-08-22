# blue-green-deployer

This repository has the Lambda function for OpsWorks deployment to support Blue / Green Deployments.

While OpsWorks supports deploying an application to a Layer or a set of instances, the Blue / Green deployment strategy suggests setting up two similar environments for production, with one receiving production traffic, and the other used to deploy / test and switch to.

We'll implement this by supporting a process where the deployments are triggered from a file upload on S3, all applications in the environment (frontend, backend) deployed together and switched together.


# Acknowledgements
Some parts of this implementation were adapted based on https://github.com/Tim-B/codepipeline-opsworks-deployer
