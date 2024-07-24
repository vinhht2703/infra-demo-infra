import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import { ENV } from '../../config/environment';

export type TSourceConfig = {
    type: 'fe' | 'be',
    name: string,
    ecr: {
        repository: string
    },
    ecs: {
        taskDef: string,
        container: string,
        containerPort: number,
        memoryLimitMiB: number,
        serviceName: string,
        desiredCount: number,
        cluster: string,
        albSg: string,
        publicAlb: string,
    }
    pipeline: {
        name: string,
        pipelineNameArtifact: string,
        source: {
            type: 'github';
            owner: string;
            repo: string;
            webhook: boolean;
            branchOrRef: string;
        };
        build: {
            projectName: string;
            buildImage: codebuild.IBuildImage;
            environmentVariables: {
                containerName: string;
                family: string;
            };
            buildSpec: codebuild.BuildSpec;
        };
        test: {},
        deploy: {}
    }
}

export const SOURCES_CONFIG: TSourceConfig[] = [
    {
        type: 'fe',
        name: 'Frontend',
        ecr: {
            repository: 'Frontend' + 'EcrRepo'
        },
        ecs: {
            taskDef: ENV.taskDefinition + '-frontend',
            container: ENV.containerName + '-frontend',
            containerPort: 80,
            memoryLimitMiB: 512,
            serviceName: ENV.serviceName + '-frontend',
            desiredCount: 1,
            cluster: ENV.clusterName + '-frontend',
            albSg: "SecurityGroup" + 'Frontend',
            publicAlb: "PublicAlb" + 'Frontend'
        },
        pipeline: {
            name: ENV.fePipelineName,
            pipelineNameArtifact: ENV.fePipelineNameArtifact,
            source: {
                type: 'github',
                owner: ENV.sourceUsername,
                repo: ENV.feSourceRepo,
                webhook: false,
                branchOrRef: ENV.feSourceBranch,
            },
            build: {
                projectName: ENV.feCodebuildName,
                buildImage: codebuild.LinuxBuildImage.STANDARD_5_0,
                environmentVariables: {
                    containerName: ENV.containerName + '-frontend',
                    family: ENV.family + '-frontend',
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
            },
            test: {

            },
            deploy: {

            }

        }
    },
    {
        type: 'be',
        name: 'Backend',
        ecr: {
            repository: 'Backend' + 'EcrRepo'
        },
        ecs: {
            taskDef: ENV.taskDefinition + '-backend',
            container: ENV.containerName + '-backend',
            containerPort: 3000,
            memoryLimitMiB: 512,
            serviceName: ENV.serviceName + '-backend',
            desiredCount: 1,
            cluster: ENV.clusterName + '-backend',
            albSg: "SecurityGroup" + 'Backend',
            publicAlb: "PublicAlb" + 'Backend'
        },
        pipeline: {
            name: ENV.bePipelineName,
            pipelineNameArtifact: ENV.bePipelineNameArtifact,
            source: {
                type: 'github',
                owner: ENV.sourceUsername,
                repo: ENV.beSourceRepo,
                webhook: false,
                branchOrRef: ENV.beSourceBranch,
            },
            build: {
                projectName: ENV.beCodebuildName,
                buildImage: codebuild.LinuxBuildImage.STANDARD_5_0,
                environmentVariables: {
                    containerName: ENV.containerName + '-backend',
                    family: ENV.family + '-backend',
                },
                buildSpec: codebuild.BuildSpec.fromObject({
                    version: '0.2',
                    phases: {
                        pre_build: {
                            commands: [
                                'echo $pwd',
                                'ls -la',
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
                                'pwd; ls -al;',
                                'sed -i "s|CONTAINER_NAME|${CONTAINER_NAME}|g" taskdef.json',
                                'sed -i "s|REPOSITORY_URI|${REPOSITORY_URI}|g" taskdef.json',
                                'sed -i "s|IMAGE_TAG|${IMAGE_TAG}|g" taskdef.json',
                                'sed -i "s|TASK_ROLE_ARN|${TASK_ROLE_ARN}|g" taskdef.json',
                                'sed -i "s|EXECUTION_ROLE_ARN|${EXECUTION_ROLE_ARN}|g" taskdef.json',
                                'sed -i "s|FAMILY|${FAMILY}|g" taskdef.json',
                                'sed -i "s|REGION|${REGION}|g" taskdef.json',
                                'sed -i "s|TASK_DEFINITION_ARN|${TASK_DEFINITION_ARN}|g" appspec.yaml',
                                'sed -i "s|CONTAINER_NAME|${CONTAINER_NAME}|g" appspec.yaml',
                                'cat appspec.yaml && cat taskdef.json'
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
            },
            test: {

            },
            deploy: {

            }

        }
    }
]