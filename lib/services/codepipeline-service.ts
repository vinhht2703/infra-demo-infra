// import * as cdk from 'aws-cdk-lib';
// import { Construct } from 'constructs';
// import * as codepipeline from 'aws-cdk-lib/aws-codepipeline';
// import * as codepipeline_actions from 'aws-cdk-lib/aws-codepipeline-actions';
// import * as codebuild from 'aws-cdk-lib/aws-codebuild';
// import * as codestar from 'aws-cdk-lib/aws-codestarconnections';
// import { ServiceInterface } from '../interfaces/service-interface';
// import { ENV } from '../../config/environment';

// export class CodepipelineService implements ServiceInterface {
//     private readonly scope: Construct;

//     constructor(scope: Construct, id: string, props?: cdk.StackProps) {

//         this.scope = scope;
//     }

//     init() {
//         // Create a CodeStar connection to GitHub
//         const connection = new codestar.CfnConnection(this.scope, 'GitHubConnection', {
//             connectionName: 'my-github-connection',
//             providerType: 'GitHub',
//         });

//         // Define the source artifact
//         const sourceOutput = new codepipeline.Artifact();

//         // Define the pipeline
//         const pipeline = new codepipeline.Pipeline(this.scope, 'MyPipeline', {
//             pipelineName: 'MyPipeline',
//             stages: [
//                 {
//                     stageName: 'Source',
//                     actions: [
//                         new codepipeline_actions.CodeStarConnectionsSourceAction({
//                             actionName: 'GitHub_Source',
//                             owner: ENV.sourceUsername,
//                             repo: ENV.feSourceRepo,
//                             branch: ENV.feSourceBranch, // or the default branch of your GitHub repo
//                             output: sourceOutput,
//                             connectionArn: connection.attrConnectionArn,
//                         }),
//                     ],
//                 },
//                 {
//                     stageName: 'Build',
//                     actions: [
//                         new codepipeline_actions.CodeBuildAction({
//                             actionName: 'CodeBuild',
//                             project: new codebuild.PipelineProject(this.scope, 'MyProject', {
//                                 buildSpec: codebuild.BuildSpec.fromObject({
//                                     version: '0.2',
//                                     phases: {
//                                         install: {
//                                             commands: ['npm install'],
//                                         },
//                                         build: {
//                                             commands: ['npm run build'],
//                                         },
//                                     },
//                                     artifacts: {
//                                         'base-directory': 'dist',
//                                         files: [
//                                             "appspec.yaml",
//                                             "taskdef.json"
//                                         ],
//                                     },
//                                 }),
//                             }),
//                             input: sourceOutput,
//                         }),
//                     ],
//                 },
//             ],
//         });

//         // Output the pipeline ARN
//         new cdk.CfnOutput(this.scope, 'PipelineArn', {
//             value: pipeline.pipelineArn,
//         });
//     }
// }
