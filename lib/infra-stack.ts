import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as codepipeline from 'aws-cdk-lib/aws-codepipeline';
import * as codepipeline_actions from 'aws-cdk-lib/aws-codepipeline-actions';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import { ENV } from '../config/environment';

export class InfraStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Create an ECR repository
    const ecrRepository = new ecr.Repository(this, 'MyEcrRepo');

    // Create Fargate service
    const ecsService = initFargate(this, ecrRepository)

    // Create CICD
    const pipeline = initCICD(this, ecrRepository, ecsService.taskDefinition, ecsService)


    // Output the pipeline ARN
    new cdk.CfnOutput(this, 'PipelineArn', {
      value: pipeline.pipelineArn,
    });

    // Outputs the ALB public endpoint
    // new cdk.CfnOutput(this, "PublicAlbEndpoint", {
    //   value: "http://" + publicAlb.loadBalancerDnsName,
    // });
  }
}

function initFargate(scope: Construct, ecrRepository: cdk.aws_ecr.Repository) {
  // Create an ECS cluster
  const cluster = new ecs.Cluster(scope, ENV.clusterName, {
    vpc: new ec2.Vpc(scope, ENV.vpcName, { maxAzs: 3 })
  });

  // Define the ECS task definition
  const taskDefinition = new ecs.FargateTaskDefinition(scope, ENV.taskDefinition);
  const container = taskDefinition.addContainer(ENV.containerName, {
    image: ecs.ContainerImage.fromEcrRepository(ecrRepository),
    memoryLimitMiB: 512,
  });
  container.addPortMappings({ containerPort: 80 });

  // Define the ECS service
  const ecsService = new ecs.FargateService(scope, ENV.serviceName, {
    cluster,
    taskDefinition,
    desiredCount: 1,
  });

  return ecsService
}

function initCICD(
  scope: Construct,
  ecrRepository: cdk.aws_ecr.Repository,
  taskDefinition: cdk.aws_ecs.FargateTaskDefinition,
  ecsService: cdk.aws_ecs.FargateService,
) {
  // Define the source artifact
  const sourceOutput = new codepipeline.Artifact();
  const buildOutput = new codepipeline.Artifact();

  const gitHubSource = codebuild.Source.gitHub({
    owner: ENV.sourceUsername,
    repo: ENV.feSourceRepo,
    webhook: false,
    branchOrRef: ENV.feSourceBranch,
  });

  // Define the build project
  const project = new codebuild.Project(scope, 'MyProject', {
    projectName: ENV.codebuildName,
    source: gitHubSource,
    environment: {
      buildImage: codebuild.LinuxBuildImage.STANDARD_5_0,
      privileged: true,
    },
    environmentVariables: {
      REPOSITORY_URI: { value: ecrRepository.repositoryUri },
      AWS_ACCOUNT_ID: { value: process.env?.CDK_DEFAULT_ACCOUNT || "" },
      REGION: { value: process.env?.CDK_DEFAULT_REGION || "" },
      IMAGE_TAG: { value: "latest" },
      IMAGE_REPO_NAME: { value: ecrRepository.repositoryName },
      TASK_DEFINITION_ARN: { value: taskDefinition.taskDefinitionArn },
      TASK_ROLE_ARN: { value: taskDefinition.taskRole.roleArn },
      EXECUTION_ROLE_ARN: { value: taskDefinition.executionRole?.roleArn },
    },
    buildSpec: codebuild.BuildSpec.fromObject({
      version: '0.2',
      phases: {
        pre_build: {
          commands: [
            'echo $pwd',
            'ls -la',
            'cd app',
            'echo Logging in to Amazon ECR...',
            'aws --version',
            'aws ecr get-login-password --region $REGION | docker login --username AWS --password-stdin $AWS_ACCOUNT_ID.dkr.ecr.$REGION.amazonaws.com'
          ],
        },
        build: {
          commands: [
            'echo Building the Docker image...',
            'docker build -t $IMAGE_REPO_NAME:$IMAGE_TAG .',
            'docker tag $IMAGE_REPO_NAME:$IMAGE_TAG $AWS_ACCOUNT_ID.dkr.ecr.$REGION.amazonaws.com/$IMAGE_REPO_NAME:$IMAGE_TAG'
          ],
        },
        post_build: {
          commands: [
            'echo Pushing the Docker image...',
            'docker push $REPOSITORY_URI:$IMAGE_TAG',
            'echo Container image to be used $REPOSITORY_URI:$IMAGE_TAG',
            `printf \'[{"name":"${ENV.containerName}","imageUri":"%s"}]\' $REPOSITORY_URI:$IMAGE_TAG > imagedefinitions.json`,
            'pwd; ls -al; cat imagedefinitions.json',
          ]
        }
      },
      env: {
        'exported-variables': ['REPOSITORY_URI'],
      },
      artifacts: {
        files: ['imagedefinitions.json'],
        'base-directory': 'app', // relative directory for the artifacts
        'discard-paths': 'no',
      }
    }),
    artifacts: codebuild.Artifacts.s3({
      bucket: new s3.Bucket(scope, 'ArtifactBuildBucket', {
        bucketName: ENV.buildNameArtifact,
      }),
    }),
  });

  // Grant necessary permissions to the CodeBuild project
  ecrRepository.grantPullPush(project.role!);

  // Define the pipeline
  const pipeline = new codepipeline.Pipeline(scope, 'MyPipeline', {
    pipelineName: ENV.pipelineName,
    artifactBucket: new s3.Bucket(scope, 'PipelineArtifact', {
      bucketName: ENV.pipelineNameArtifact,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    }),
    stages: [
      {
        stageName: 'Source',
        actions: [
          new codepipeline_actions.CodeStarConnectionsSourceAction({
            actionName: 'GitHub_Source',
            owner: ENV.sourceUsername,
            repo: ENV.feSourceRepo,
            branch: ENV.feSourceBranch, // or the default branch of your GitHub repo
            output: sourceOutput,
            connectionArn: ENV.codestarArn,
          }),
        ],
      },
      {
        stageName: 'Build',
        actions: [
          new codepipeline_actions.CodeBuildAction({
            actionName: 'CodeBuild',
            project: project,
            input: sourceOutput,
            outputs: [buildOutput], // optional
          }),
        ],
      },
      {
        stageName: 'Deploy',
        actions: [
          new codepipeline_actions.EcsDeployAction({
            actionName: 'ECS_Deploy',
            service: ecsService,
            imageFile: new codepipeline.ArtifactPath(
              buildOutput,
              'imagedefinitions.json',
            ),
          }),
        ],
      },
    ],
  });

  return pipeline
}
