import { getEnv } from '../lib/utils/environment';

export const project = getEnv('PROJECT_NAME')
export const stage = getEnv('STG')
export const prefix = `${project}-${stage}`;
export const ENV = {
  projectName: getEnv('PROJECT_NAME'),
  stage: stage,
  distribution: `${stage.toLowerCase()}-distribution`,
  vpcName: `${stage.toLowerCase()}-vpc`,
  cidrBlock: '10.128.0.0/16',

  // pipeline
  sourceUsername: getEnv('GITHUB_USERNAME'),
  feSourceRepo: getEnv('GITHUB_REPO_FE'),
  feSourceBranch: getEnv('GITHUB_BRANCH_FE'),
  beSourceRepo: getEnv('GITHUB_REPO_BE'),
  beSourceBranch: getEnv('GITHUB_BRANCH_BE'),
  codestarArn: getEnv('CODESTAR_ARN'),

  // ECS fargate
  loadbalancerName: `${prefix}-loadbalancer`,
  clusterName: `${prefix}-cluster`,
  roleName: `${prefix}-ecs-role`,
  containerName: `${prefix}-container`,
  taskDefinition: `${prefix}-task-definition`,
  serviceName: `${prefix}-service`,
  logGroupName: `${prefix}-ecs`,
  streamPrefix: `${prefix}-stream`,
  family: `${prefix}-family`,

  // CI CD
  /// frontend
  feCodebuildName: `${prefix}-frontend`,
  fePipelineName: `${prefix}-frontend`,
  fePipelineNameArtifact: `${prefix}-pipeline-artifact-frontend`,
  feBuildNameArtifact: `${prefix}-build-artifact-frontend`,
  /// backend
  beCodebuildName: `${prefix}-backend`,
  bePipelineName: `${prefix}-backend`,
  bePipelineNameArtifact: `${prefix}-pipeline-artifact-backend`,
  beBuildNameArtifact: `${prefix}-build-artifact-backend`,

  // database
  dbName: `demoInfraDb${stage.toUpperCase()}`,
};
