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
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as custom from "aws-cdk-lib/custom-resources";
import * as elb from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as codedeploy from "aws-cdk-lib/aws-codedeploy";
import * as pipelineactions from "aws-cdk-lib/aws-codepipeline-actions";
import { ENV } from '../config/environment';

export class InfraStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Create cluster vpc
    const clusterVpc = initVpc(this)

    // Create an ECR repository
    const ecrRepository = new ecr.Repository(this, 'MyEcrRepo');

    // Create Fargate service
    const { ecsService, publicAlb, albListener, targetGroupBlue, targetGroupGreen } = initFargate(this, ecrRepository, clusterVpc)

    // Create CICD
    const { pipeline, buildProject } = initCICD({ scope: this, ecrRepository, ecsService, albListener, targetGroupBlue, targetGroupGreen })

    // Create trigger codebuild lambda
    const triggerLambda = initTriggerCodeBuildLambda(this, buildProject)

    // Deploys the cluster VPC after the initial image build triggers
    clusterVpc.node.addDependency(triggerLambda);

    // Outputs the ALB public endpoint
    new cdk.CfnOutput(this, "PublicAlbEndpoint", {
      value: "http://" + publicAlb.loadBalancerDnsName,
    });
  }
}

function initFargate(scope: Construct, ecrRepository: cdk.aws_ecr.Repository, clusterVpc: cdk.aws_ec2.Vpc) {
  // Creates a Task Definition for the ECS Fargate service
  const fargateTaskDef = new ecs.FargateTaskDefinition(
    scope,
    ENV.taskDefinition
  );
  fargateTaskDef.addContainer("container", {
    containerName: ENV.containerName,
    image: ecs.ContainerImage.fromEcrRepository(ecrRepository),
    memoryLimitMiB: 512,
    portMappings: [{ containerPort: 80 }],
  });

  // Creates a new blue Target Group that routes traffic from the public Application Load Balancer (ALB) to the
  // registered targets within the Target Group e.g. (EC2 instances, IP addresses, Lambda functions)
  // https://docs.aws.amazon.com/elasticloadbalancing/latest/application/load-balancer-target-groups.html
  const targetGroupBlue = new elb.ApplicationTargetGroup(
    scope,
    "BlueTargetGroup",
    {
      targetGroupName: "alb-blue-tg",
      targetType: elb.TargetType.IP,
      port: 80,
      vpc: clusterVpc,
    }
  );

  // Creates a new green Target Group
  const targetGroupGreen = new elb.ApplicationTargetGroup(
    scope,
    "GreenTargetGroup",
    {
      targetGroupName: "alb-green-tg",
      targetType: elb.TargetType.IP,
      port: 80,
      vpc: clusterVpc,
    }
  );

  // Creates a Security Group for the Application Load Balancer (ALB)
  const albSg = new ec2.SecurityGroup(scope, "SecurityGroup", {
    vpc: clusterVpc,
    allowAllOutbound: true,
  });
  albSg.addIngressRule(
    ec2.Peer.anyIpv4(),
    ec2.Port.tcp(80),
    "Allows access on port 80/http",
    false
  );

  // Creates a public ALB
  const publicAlb = new elb.ApplicationLoadBalancer(scope, "PublicAlb", {
    vpc: clusterVpc,
    internetFacing: true,
    securityGroup: albSg,
  });

  // Adds a listener on port 80 to the ALB
  const albListener = publicAlb.addListener("AlbListener80", {
    open: false,
    port: 80,
    defaultTargetGroups: [targetGroupBlue],
  });

  // Define the ECS service
  const ecsService = new ecs.FargateService(scope, ENV.serviceName, {
    desiredCount: 1,
    serviceName: ENV.serviceName,
    taskDefinition: fargateTaskDef,
    cluster: new ecs.Cluster(scope, "EcsCluster", {
      enableFargateCapacityProviders: true,
      vpc: clusterVpc,
    }),
    // Sets CodeDeploy as the deployment controller
    deploymentController: {
      type: ecs.DeploymentControllerType.CODE_DEPLOY,
    },
  });

  // Adds the ECS Fargate service to the ALB target group
  ecsService.attachToApplicationTargetGroup(targetGroupBlue);

  return { ecsService, publicAlb, albListener, targetGroupBlue, targetGroupGreen }
}

function initCICD(
  {
    scope,
    ecrRepository,
    ecsService,
    albListener,
    targetGroupBlue,
    targetGroupGreen
  }: {
    scope: Construct,
    ecrRepository: cdk.aws_ecr.Repository,
    ecsService: cdk.aws_ecs.FargateService,
    albListener: cdk.aws_elasticloadbalancingv2.ApplicationListener,
    targetGroupBlue: cdk.aws_elasticloadbalancingv2.ApplicationTargetGroup,
    targetGroupGreen: cdk.aws_elasticloadbalancingv2.ApplicationTargetGroup
  }
) {
  const taskDefinition = ecsService.taskDefinition

  // Define the source artifact
  const sourceArtifact = new codepipeline.Artifact('SourceArtifact');
  const buildArtifact = new codepipeline.Artifact('BuildArtifact');

  const gitHubSource = codebuild.Source.gitHub({
    owner: ENV.sourceUsername,
    repo: ENV.feSourceRepo,
    webhook: false,
    branchOrRef: ENV.feSourceBranch,
  });

  // Define the build project
  const buildProject = new codebuild.Project(scope, 'MyProject', {
    projectName: ENV.codebuildName,
    source: gitHubSource,
    environment: {
      buildImage: codebuild.LinuxBuildImage.STANDARD_5_0,
      privileged: true,
    },
    environmentVariables: {
      CONTAINER_NAME: { value: ENV.containerName },
      REPOSITORY_URI: { value: ecrRepository.repositoryUri },
      AWS_ACCOUNT_ID: { value: process.env?.CDK_DEFAULT_ACCOUNT || "" },
      REGION: { value: process.env?.CDK_DEFAULT_REGION || "" },
      IMAGE_TAG: { value: "latest" },
      IMAGE_REPO_NAME: { value: ecrRepository.repositoryName },
      TASK_DEFINITION_ARN: { value: taskDefinition.taskDefinitionArn },
      TASK_ROLE_ARN: { value: taskDefinition.taskRole.roleArn },
      EXECUTION_ROLE_ARN: { value: taskDefinition.executionRole?.roleArn },
      FAMILY: { value: ENV.feFamily },
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
            // `printf \'[{"name":"${ENV.containerName}","imageUri":"%s"}]\' $REPOSITORY_URI:$IMAGE_TAG > imagedefinitions.json`,
            // 'cat imagedefinitions.json',
            'pwd; ls -al;',
            'sed -i "s|CONTAINER_NAME|${CONTAINER_NAME}|g" taskdef.json',
            'sed -i "s|REPOSITORY_URI|${REPOSITORY_URI}|g" taskdef.json',
            'sed -i "s|IMAGE_TAG|${IMAGE_TAG}|g" taskdef.json',
            'sed -i "s|TASK_ROLE_ARN|${TASK_ROLE_ARN}|g" taskdef.json',
            'sed -i "s|EXECUTION_ROLE_ARN|${EXECUTION_ROLE_ARN}|g" taskdef.json',
            'sed -i "s|FAMILY|${FAMILY}|g" taskdef.json',
            'sed -i "s|TASK_DEFINITION_ARN|${TASK_DEFINITION_ARN}|g" appspec.yaml',
            'sed -i "s|CONTAINER_NAME|${CONTAINER_NAME}|g" appspec.yaml',
            'cat appspec.yaml && cat taskdef.json',
            'cp appspec.yaml ../',
            'cp taskdef.json ../'
          ]
        }
      },
      env: {
        'exported-variables': ['REPOSITORY_URI'],
      },
      artifacts: {
        files: ['taskdef.json', 'appspec.yaml'],
      }
    }),
  });

  // Grant necessary permissions to the CodeBuild project
  ecrRepository.grantPullPush(buildProject);

  const sourceStage = {
    stageName: 'Source',
    actions: [
      new codepipeline_actions.CodeStarConnectionsSourceAction({
        actionName: 'GitHub_Source',
        owner: ENV.sourceUsername,
        repo: ENV.feSourceRepo,
        branch: ENV.feSourceBranch, // or the default branch of your GitHub repo
        output: sourceArtifact,
        connectionArn: ENV.codestarArn,
      }),
    ],
  }

  const buildStage = {
    stageName: 'Build',
    actions: [
      new codepipeline_actions.CodeBuildAction({
        actionName: 'CodeBuild',
        project: buildProject,
        input: sourceArtifact,
        outputs: [buildArtifact], // optional
      }),
    ],
  }

  // Creates a new CodeDeploy Deployment Group
  const deploymentGroup = new codedeploy.EcsDeploymentGroup(
    scope,
    "CodeDeployGroup",
    {
      service: ecsService,
      // Configurations for CodeDeploy Blue/Green deployments
      blueGreenDeploymentConfig: {
        listener: albListener,
        blueTargetGroup: targetGroupBlue,
        greenTargetGroup: targetGroupGreen,
      },
    }
  );

  const deployStage = {
    stageName: 'Deploy',
    actions: [
      new pipelineactions.CodeDeployEcsDeployAction({
        actionName: "EcsFargateDeploy",
        appSpecTemplateInput: buildArtifact,
        taskDefinitionTemplateInput: buildArtifact,
        deploymentGroup: deploymentGroup,
      }),
    ],
  }

  // Define the pipeline
  const pipeline = new codepipeline.Pipeline(scope, 'MyPipeline', {
    pipelineName: ENV.pipelineName,
    artifactBucket: new s3.Bucket(scope, 'PipelineArtifact', {
      bucketName: ENV.pipelineNameArtifact,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    }),
    stages: [
      sourceStage,
      buildStage,
      deployStage
    ],
  });

  return { pipeline, buildProject }
}

function initTriggerCodeBuildLambda(scope: Construct, buildProject: cdk.aws_codebuild.Project) {
  // Lambda function that triggers CodeBuild image build project
  const triggerCodeBuild = new lambda.Function(scope, "BuildLambda", {
    architecture: lambda.Architecture.ARM_64,
    code: lambda.Code.fromAsset("./lib/lambda"),
    handler: "trigger-build.handler",
    runtime: lambda.Runtime.NODEJS_18_X,
    environment: {
      REGION: process.env.CDK_DEFAULT_REGION!,
      CODEBUILD_PROJECT_NAME: buildProject.projectName,
    },
    // Allows this Lambda function to trigger the buildImage CodeBuild project
    initialPolicy: [
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["codebuild:StartBuild"],
        resources: [buildProject.projectArn],
      }),
    ],
  });

  // Triggers a Lambda function using AWS SDK
  return new custom.AwsCustomResource(
    scope,
    "BuildLambdaTrigger",
    {
      installLatestAwsSdk: true,
      policy: custom.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ["lambda:InvokeFunction"],
          resources: [triggerCodeBuild.functionArn],
        }),
      ]),
      onCreate: {
        service: "Lambda",
        action: "invoke",
        physicalResourceId: custom.PhysicalResourceId.of("id"),
        parameters: {
          FunctionName: triggerCodeBuild.functionName,
          InvocationType: "Event",
        },
      },
      onUpdate: {
        service: "Lambda",
        action: "invoke",
        parameters: {
          FunctionName: triggerCodeBuild.functionName,
          InvocationType: "Event",
        },
      },
    }
  );
}

function initVpc(scope: Construct) {
  // Creates VPC for the ECS Cluster
  const clusterVpc = new ec2.Vpc(scope, "ClusterVpc", {
    ipAddresses: ec2.IpAddresses.cidr(ENV.cidrBlock),
  });

  return clusterVpc
}
