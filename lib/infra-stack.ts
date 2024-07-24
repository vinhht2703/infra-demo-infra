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
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as rds from "aws-cdk-lib/aws-rds";
import { ENV } from '../config/environment';
import { SOURCES_CONFIG, TSourceConfig } from './config/source-config';

export class InfraStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Create cluster vpc
    const clusterVpc = initVpc(this)

    // Create MySql RDS
    // const rds = initMySqlRds(this, clusterVpc)

    SOURCES_CONFIG.forEach(sourceConfig => {
      // if (sourceConfig.type == 'be') {
      // Create an ECR repository
      const ecrRepository = new ecr.Repository(this, sourceConfig.ecr.repository);
      // Create Fargate service
      const { ecsService, albListener, targetGroupBlue, targetGroupGreen } = initFargate(this, ecrRepository, clusterVpc, sourceConfig)

      // Create CICD
      const cicd = initCicd({ scope: this, ecrRepository, ecsService, albListener, targetGroupBlue, targetGroupGreen, sourceConfig })

      // Create trigger codebuild lambda
      const triggerLambda = initTriggerCodeBuildLambda(this, cicd.buildProject, sourceConfig)

      // Deploys the cluster VPC after the initial image build triggers
      clusterVpc.node.addDependency(triggerLambda);
      // }
    });
  }
}

function initFargate(scope: Construct, ecrRepository: cdk.aws_ecr.Repository, clusterVpc: cdk.aws_ec2.Vpc, sourceConfig: TSourceConfig) {
  // Creates a Task Definition for the ECS Fargate service
  const fargateTaskDef = new ecs.FargateTaskDefinition(
    scope,
    sourceConfig.ecs.taskDef
  );
  fargateTaskDef.addContainer(sourceConfig.ecs.container, {
    containerName: sourceConfig.ecs.container,
    image: ecs.ContainerImage.fromEcrRepository(ecrRepository),
    memoryLimitMiB: sourceConfig.ecs.memoryLimitMiB,
    portMappings: [{ containerPort: sourceConfig.ecs.containerPort }],
  });

  // Creates a new blue Target Group that routes traffic from the public Application Load Balancer (ALB) to the
  // registered targets within the Target Group e.g. (EC2 instances, IP addresses, Lambda functions)
  // https://docs.aws.amazon.com/elasticloadbalancing/latest/application/load-balancer-target-groups.html
  const targetGroupBlue = new elb.ApplicationTargetGroup(
    scope,
    "BlueTargetGroup" + sourceConfig.name,
    {
      targetGroupName: "alb-blue-tg-" + sourceConfig.type,
      targetType: elb.TargetType.IP,
      port: sourceConfig.ecs.containerPort,
      protocol: elb.ApplicationProtocol.HTTP,
      healthCheck: {
        path: sourceConfig.type == 'be' ? '/health' : '/',
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 2,
      },
      vpc: clusterVpc,
    }
  );

  // Creates a new green Target Group
  const targetGroupGreen = new elb.ApplicationTargetGroup(
    scope,
    "GreenTargetGroup" + sourceConfig.name,
    {
      targetGroupName: "alb-green-tg-" + sourceConfig.type,
      targetType: elb.TargetType.IP,
      port: sourceConfig.ecs.containerPort,
      protocol: elb.ApplicationProtocol.HTTP,
      healthCheck: {
        path: sourceConfig.type == 'be' ? '/health' : '/',
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 2,
      },
      vpc: clusterVpc,
    }
  );

  // Creates a Security Group for the Application Load Balancer (ALB)
  const albSg = new ec2.SecurityGroup(scope, sourceConfig.ecs.albSg, {
    vpc: clusterVpc,
    allowAllOutbound: true,
  });
  albSg.addIngressRule(
    ec2.Peer.anyIpv4(),
    ec2.Port.tcp(sourceConfig.ecs.containerPort),
    `Allows access on port ${sourceConfig.ecs.containerPort}/http`,
    false
  );

  if (sourceConfig.type == 'be') {
    albSg.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(80),
      `Allows access on port 80/http`,
      false
    );
  }

  // Creates a public ALB
  const publicAlb = new elb.ApplicationLoadBalancer(scope, sourceConfig.ecs.publicAlb, {
    vpc: clusterVpc,
    internetFacing: true,
    securityGroup: albSg,
  });

  // Adds a listener on port to the ALB
  const albListener = publicAlb.addListener("AlbListener" + sourceConfig.ecs.containerPort, {
    open: false,
    port: 80,
    protocol: elb.ApplicationProtocol.HTTP,
    defaultTargetGroups: [targetGroupBlue],
  });

  // Define the ECS service
  const ecsService = new ecs.FargateService(scope, sourceConfig.ecs.serviceName, {
    desiredCount: sourceConfig.ecs.desiredCount,
    serviceName: sourceConfig.ecs.serviceName,
    taskDefinition: fargateTaskDef,
    cluster: new ecs.Cluster(scope, sourceConfig.ecs.cluster, {
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

  // Outputs the ALB public endpoint
  new cdk.CfnOutput(scope, "PublicAlbEndpoint" + sourceConfig.name, {
    value: "http://" + publicAlb.loadBalancerDnsName,
  });

  return { ecsService, albListener, targetGroupBlue, targetGroupGreen }
}

function initCicd(
  {
    scope,
    ecrRepository,
    ecsService,
    albListener,
    targetGroupBlue,
    targetGroupGreen,
    sourceConfig
  }: {
    scope: Construct,
    ecrRepository: cdk.aws_ecr.Repository,
    ecsService: cdk.aws_ecs.FargateService,
    albListener: cdk.aws_elasticloadbalancingv2.ApplicationListener,
    targetGroupBlue: cdk.aws_elasticloadbalancingv2.ApplicationTargetGroup,
    targetGroupGreen: cdk.aws_elasticloadbalancingv2.ApplicationTargetGroup,
    sourceConfig: TSourceConfig
  }
) {
  const taskDefinition = ecsService.taskDefinition

  // Define the source artifact
  const sourceArtifact = new codepipeline.Artifact('SourceArtifact');
  const buildArtifact = new codepipeline.Artifact('BuildArtifact');

  const gitHubSource = codebuild.Source.gitHub({
    owner: sourceConfig.pipeline.source.owner,
    repo: sourceConfig.pipeline.source.repo,
    webhook: sourceConfig.pipeline.source.webhook,
    branchOrRef: sourceConfig.pipeline.source.branchOrRef,
  });

  // Define the build project
  const buildProject = new codebuild.Project(scope, sourceConfig.name + 'Project', {
    projectName: sourceConfig.pipeline.build.projectName,
    source: gitHubSource,
    environment: {
      buildImage: sourceConfig.pipeline.build.buildImage,
      privileged: true,
    },
    environmentVariables: {
      CONTAINER_NAME: { value: sourceConfig.pipeline.build.environmentVariables.containerName },
      REPOSITORY_URI: { value: ecrRepository.repositoryUri },
      AWS_ACCOUNT_ID: { value: process.env?.CDK_DEFAULT_ACCOUNT || "" },
      REGION: { value: process.env?.CDK_DEFAULT_REGION || "" },
      IMAGE_TAG: { value: "latest" },
      IMAGE_REPO_NAME: { value: ecrRepository.repositoryName },
      TASK_DEFINITION_ARN: { value: taskDefinition.taskDefinitionArn },
      TASK_ROLE_ARN: { value: taskDefinition.taskRole.roleArn },
      EXECUTION_ROLE_ARN: { value: taskDefinition.executionRole?.roleArn },
      FAMILY: { value: sourceConfig.pipeline.build.environmentVariables.family },
    },
    buildSpec: sourceConfig.pipeline.build.buildSpec,
  });

  // Grant necessary permissions to the CodeBuild project
  ecrRepository.grantPullPush(buildProject);

  const sourceStage = {
    stageName: 'Source',
    actions: [
      new codepipeline_actions.CodeStarConnectionsSourceAction({
        actionName: 'GitHub_Source',
        owner: sourceConfig.pipeline.source.owner,
        repo: sourceConfig.pipeline.source.repo,
        branch: sourceConfig.pipeline.source.branchOrRef, // or the default branch of your GitHub repo
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
    sourceConfig.name + "CodeDeployGroup",
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
  const pipeline = new codepipeline.Pipeline(scope, sourceConfig.name + 'Pipeline', {
    pipelineName: sourceConfig.pipeline.name,
    artifactBucket: new s3.Bucket(scope, sourceConfig.name + 'PipelineArtifact', {
      bucketName: sourceConfig.pipeline.pipelineNameArtifact,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    }),
    stages: [
      sourceStage,
      buildStage,
      deployStage
    ],
  });

  return { pipeline, buildProject }
}

function initTriggerCodeBuildLambda(scope: Construct, buildProject: cdk.aws_codebuild.Project, sourceConfig: TSourceConfig) {
  // Lambda function that triggers CodeBuild image build project
  const triggerCodeBuild = new lambda.Function(scope, "BuildLambda" + sourceConfig.name, {
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
    "BuildLambdaTrigger" + sourceConfig.name,
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

function initMySqlRds(scope: Construct, vpc: ec2.Vpc) {
  // Create a Security Group for the RDS instance
  const rdsSecurityGroup = new ec2.SecurityGroup(scope, 'RdsSecurityGroup', {
    vpc,
    allowAllOutbound: true,
  });
  rdsSecurityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(3306), 'Allow MySQL traffic');

  // Create a Security Group for the EC2 instance
  const ec2SecurityGroup = new ec2.SecurityGroup(scope, 'Ec2SecurityGroup', {
    vpc,
    allowAllOutbound: true,
  });
  ec2SecurityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(22), 'Allow SSH access');

  // Allow EC2 to connect to RDS
  rdsSecurityGroup.addIngressRule(ec2SecurityGroup, ec2.Port.tcp(3306), 'Allow EC2 access to RDS');

  // Create a Secret for the RDS instance credentials
  const dbCredentialsSecret = new secretsmanager.Secret(scope, 'DBCredentialsSecret', {
    secretName: 'mysqlCredentials',
    generateSecretString: {
      secretStringTemplate: JSON.stringify({
        username: 'admin',
      }),
      excludePunctuation: true,
      includeSpace: false,
      generateStringKey: 'password',
    },
  });

  // Create the RDS MySQL instance
  const dbInstance = new rds.DatabaseInstance(scope, 'MyRdsInstance', {
    engine: rds.DatabaseInstanceEngine.mysql({
      version: rds.MysqlEngineVersion.VER_8_0_37,
    }),
    instanceType: ec2.InstanceType.of(ec2.InstanceClass.BURSTABLE3, ec2.InstanceSize.MICRO),
    vpc,
    credentials: rds.Credentials.fromSecret(dbCredentialsSecret),
    multiAz: false,
    allocatedStorage: 20,
    maxAllocatedStorage: 100,
    allowMajorVersionUpgrade: false,
    autoMinorVersionUpgrade: true,
    backupRetention: cdk.Duration.days(7),
    deleteAutomatedBackups: true,
    removalPolicy: cdk.RemovalPolicy.DESTROY,
    deletionProtection: false,
    databaseName: ENV.dbName,
    securityGroups: [rdsSecurityGroup],
    publiclyAccessible: true,
  });

  // Create an EC2 instance
  const ec2Instance = new ec2.Instance(scope, 'MyEc2Instance', {
    instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MICRO),
    machineImage: ec2.MachineImage.latestAmazonLinux2(),
    vpc,
    securityGroup: ec2SecurityGroup,
    keyName: 'demo-infra-rds-dev', // Replace with your key pair name,
    vpcSubnets: {
      subnetType: ec2.SubnetType.PUBLIC,
    },
  });

  // Allow the EC2 instance to read the RDS secret
  dbCredentialsSecret.grantRead(ec2Instance.role);

  // Output the database endpoint
  new cdk.CfnOutput(scope, 'DBEndpoint', {
    value: dbInstance.instanceEndpoint.hostname,
  });

  // Output the secret ARN
  new cdk.CfnOutput(scope, 'DBSecretARN', {
    value: dbCredentialsSecret.secretArn,
  });

  // Output the EC2 instance public DNS
  new cdk.CfnOutput(scope, 'EC2PublicDNS', {
    value: ec2Instance.instancePublicDnsName,
  });

  return { dbRdsInstance: dbInstance, dbEc2Instance: ec2Instance }
}
