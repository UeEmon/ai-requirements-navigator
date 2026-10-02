import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CfnOutput,
  Duration,
  RemovalPolicy,
  Stack,
  type StackProps,
  aws_certificatemanager as acm,
  aws_cognito as cognito,
  aws_ec2 as ec2,
  aws_ecs as ecs,
  aws_ecs_patterns as patterns,
  aws_elasticloadbalancingv2 as elbv2,
  aws_kms as kms,
  aws_logs as logs,
  aws_rds as rds,
  aws_s3 as s3,
  aws_secretsmanager as sm,
} from "aws-cdk-lib";
import type { Construct } from "constructs";

export interface ArnStackProps extends StackProps {
  certificateArn?: string;
  dbInstanceClass: string;
  desiredCount: number;
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

/**
 * ローカルDockerと同じコンテナイメージを ECS Fargate で動かす。
 *   ローカル        → AWS
 *   postgres        → RDS for PostgreSQL
 *   MASTER_KEY      → AWS KMS
 *   ボリューム       → S3
 *   dev認証/Keycloak → Amazon Cognito
 */
export class ArnStack extends Stack {
  constructor(scope: Construct, id: string, props: ArnStackProps) {
    super(scope, id, props);

    const vpc = new ec2.Vpc(this, "Vpc", { maxAzs: 2, natGateways: 1 });

    // 組織ごとのAIのAPIキー、DB、S3 の暗号化に使う
    const key = new kms.Key(this, "AppKey", {
      enableKeyRotation: true,
      description: "AI要件定義支援: APIキー・データ暗号化",
      removalPolicy: RemovalPolicy.RETAIN,
    });

    const bucket = new s3.Bucket(this, "Artifacts", {
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: key,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      versioned: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    const db = new rds.DatabaseInstance(this, "Db", {
      engine: rds.DatabaseInstanceEngine.postgres({ version: rds.PostgresEngineVersion.VER_16 }),
      instanceType: new ec2.InstanceType(props.dbInstanceClass),
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      databaseName: "arn",
      credentials: rds.Credentials.fromGeneratedSecret("arn"),
      storageEncrypted: true,
      storageEncryptionKey: key,
      backupRetention: Duration.days(7),
      deletionProtection: true,
      removalPolicy: RemovalPolicy.SNAPSHOT,
    });

    // 認証: Cognito。組織IDはカスタム属性、権限はグループで表す
    const userPool = new cognito.UserPool(this, "Users", {
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      mfa: cognito.Mfa.OPTIONAL,
      mfaSecondFactor: { sms: false, otp: true },
      customAttributes: { org_id: new cognito.StringAttribute({ mutable: true }) },
      passwordPolicy: { minLength: 12 },
      removalPolicy: RemovalPolicy.RETAIN,
    });
    for (const g of ["admin", "editor", "reviewer", "viewer"]) {
      new cognito.CfnUserPoolGroup(this, `Group-${g}`, { userPoolId: userPool.userPoolId, groupName: g });
    }
    const client = userPool.addClient("WebClient", {
      authFlows: { userSrp: true },
      oAuth: { flows: { authorizationCodeGrant: true }, scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL] },
      readAttributes: new cognito.ClientAttributes().withCustomAttributes("org_id").withStandardAttributes({ email: true }),
    });

    // 最初の組織を作るためのトークン
    const bootstrap = new sm.Secret(this, "BootstrapToken", {
      generateSecretString: { passwordLength: 40, excludePunctuation: true },
    });

    const cluster = new ecs.Cluster(this, "Cluster", { vpc, containerInsightsV2: ecs.ContainerInsights.ENABLED });
    const certificate = props.certificateArn
      ? acm.Certificate.fromCertificateArn(this, "Cert", props.certificateArn)
      : undefined;

    const service = new patterns.ApplicationLoadBalancedFargateService(this, "App", {
      cluster,
      desiredCount: props.desiredCount,
      minHealthyPercent: 100,
      circuitBreaker: { rollback: true },
      cpu: 512,
      memoryLimitMiB: 1024,
      publicLoadBalancer: true,
      certificate,
      protocol: certificate ? elbv2.ApplicationProtocol.HTTPS : elbv2.ApplicationProtocol.HTTP,
      redirectHTTP: !!certificate,
      taskImageOptions: {
        image: ecs.ContainerImage.fromAsset(ROOT, { exclude: ["deploy/aws/cdk.out", "**/node_modules"] }),
        containerPort: 8787,
        logDriver: ecs.LogDrivers.awsLogs({ streamPrefix: "app", logRetention: logs.RetentionDays.ONE_YEAR }),
        environment: {
          NODE_ENV: "production",
          STORE: "postgres",
          DB_HOST: db.dbInstanceEndpointAddress,
          DB_PORT: db.dbInstanceEndpointPort,
          DB_NAME: "arn",
          DATABASE_SSL: "true",
          DATABASE_SSL_CA: "/app/certs/rds-global-bundle.pem",
          KEY_ENCRYPTION: "aws-kms",
          KMS_KEY_ID: key.keyArn,
          STORAGE: "s3",
          S3_BUCKET: bucket.bucketName,
          AWS_REGION: this.region,
          AUTH_MODE: "oidc",
          OIDC_ISSUER: `https://cognito-idp.${this.region}.amazonaws.com/${userPool.userPoolId}`,
          OIDC_AUDIENCE: client.userPoolClientId,
          OIDC_ORG_CLAIM: "custom:org_id",
          OIDC_ROLE_CLAIM: "cognito:groups",
          ALLOW_MOCK_PROVIDER: "false",
        },
        secrets: {
          DB_USER: ecs.Secret.fromSecretsManager(db.secret!, "username"),
          DB_PASSWORD: ecs.Secret.fromSecretsManager(db.secret!, "password"),
          BOOTSTRAP_TOKEN: ecs.Secret.fromSecretsManager(bootstrap),
        },
      },
    });
    service.targetGroup.configureHealthCheck({ path: "/health" });
    // 生成AIの並列呼び出しと評価に時間がかかるため、タイムアウトを長めにする
    service.loadBalancer.setAttribute("idle_timeout.timeout_seconds", "180");

    db.connections.allowDefaultPortFrom(service.service);
    key.grantEncryptDecrypt(service.taskDefinition.taskRole);
    bucket.grantReadWrite(service.taskDefinition.taskRole);

    new CfnOutput(this, "Url", { value: `${certificate ? "https" : "http"}://${service.loadBalancer.loadBalancerDnsName}` });
    new CfnOutput(this, "UserPoolId", { value: userPool.userPoolId });
    new CfnOutput(this, "UserPoolClientId", { value: client.userPoolClientId });
    new CfnOutput(this, "BootstrapTokenSecret", { value: bootstrap.secretName });
    new CfnOutput(this, "ArtifactsBucket", { value: bucket.bucketName });
  }
}
