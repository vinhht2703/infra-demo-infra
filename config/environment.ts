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
  feSourceRepo: getEnv('GITHUB_REPO'),
  feSourceBranch: getEnv('GITHUB_BRANCH'),
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

  // CI CD
  codebuildName: `${prefix}-frontend`,
  pipelineName: `${prefix}-frontend`,
  pipelineNameArtifact: `${prefix}-pipeline-artifact`,
  buildNameArtifact: `${prefix}-build-artifact`,
};
