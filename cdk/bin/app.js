#!/usr/bin/env node
// OnMind-XPS CDK app (JavaScript, CJS). See ARCHITECTURE.md.
'use strict'
const cdk = require('aws-cdk-lib')
const { XpsStack } = require('../lib/xps-stack')

const app = new cdk.App()

const termination = app.node.tryGetContext('terminationProtection')
const terminationProtection = termination === true || termination === 'true'

new XpsStack(app, 'XpsStack', {
  description: 'OnMind-XPS: Lambda + DynamoDB (xsetup) + HTTP API',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
  terminationProtection,
})

app.synth()
