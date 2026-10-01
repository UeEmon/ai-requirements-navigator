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
  dbInstanceClass: app.node.tryGetContext("dbInstanceClass") ?? "t4g.micro",
  desiredCount: Number(app.node.tryGetContext("desiredCount") ?? 1),
});
