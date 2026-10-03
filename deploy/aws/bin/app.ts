import { App } from "aws-cdk-lib";
import { ArnStack } from "../lib/arn-stack.js";

const app = new App();
const name = app.node.tryGetContext("name") ?? "ArnStack";

new ArnStack(app, name, {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? "ap-northeast-1",
  },
  // 例: cdk deploy -c certificateArn=arn:aws:acm:... -c domainName=req.example.com
  certificateArn: app.node.tryGetContext("certificateArn"),
  domainName: app.node.tryGetContext("domainName"),
  cognitoDomainPrefix: app.node.tryGetContext("cognitoDomainPrefix"),
  dbInstanceClass: app.node.tryGetContext("dbInstanceClass") ?? "t4g.micro",
  desiredCount: Number(app.node.tryGetContext("desiredCount") ?? 1),
  // 例: -c googleOAuthClientId=xxx.apps.googleusercontent.com -c googleOAuthSecretArn=arn:aws:secretsmanager:...
  googleOAuth:
    app.node.tryGetContext("googleOAuthClientId") && app.node.tryGetContext("googleOAuthSecretArn")
      ? { clientId: app.node.tryGetContext("googleOAuthClientId"), clientSecretArn: app.node.tryGetContext("googleOAuthSecretArn") }
      : undefined,
});
