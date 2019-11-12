#!/usr/bin/env node

"use strict";

process.on('SIGINT', () => process.exit(1));
process.on('SIGTERM', () => process.exit(1));

const commander = require("commander");

const configureProfileAsync = require("../lib/configureProfileAsync");
const login = require("../lib/login");

commander
    .option("-p, --profile <name>", "The name of the profile to log in with (or configure)")
    .option("-f, --force-refresh", "Force a credential refresh, even if they are still valid")
    .option("-c, --configure", "Configure the profile")
    .option("-m, --mode <mode>", "'cli' to hide the login page and perform the login through the CLI (default behavior), 'gui' to perform the login through the Azure GUI (more reliable but only works on GUI operating system), 'debug' to show the login page but perform the login through the CLI (useful to debug issues with the CLI login)")
    .option("--no-sandbox", "Disable the Puppeteer sandbox (usually necessary on Linux)")
    .option("--prompt", "Prompt for input and override the default choice", false)
    .option("--disable-chrome-network-service", "Disable Chromium's Network Service (needed when login provider redirects with 3XX)")
    .option("--no-verify-ssl", "Disable SSL Peer Verification for connections to AWS (no effect if behind proxy)")
    .option("--disable-chrome-seamless-sso", "Disable Chromium's pass-through authentication with Azure Active Directory Seamless Single Sign-On")
    .option("--no-disable-extensions", "Tell Puppeteer not to pass the --disable-extensions flag to Chromium")
    .parse(process.argv);

const profileName = commander.profile || process.env.AWS_PROFILE || "default";
const mode = commander.mode || 'gui';
const disableSandbox = !commander.sandbox;
const noPrompt = !commander.prompt;
const disableChromeNetworkService = commander.disableChromeNetworkService;
const awsNoVerifySsl = !commander.verifySsl;
const disableChromeSeamlessSso = commander.disableChromeSeamlessSso;
const forceRefresh = commander.forceRefresh;
const noDisableExtensions = !commander.disableExtensions;


Promise.resolve()
    .then(() => {
        if (commander.configure) return configureProfileAsync(profileName);
        
        return login.loginAll(mode, disableSandbox, noPrompt, disableChromeNetworkService, awsNoVerifySsl, disableChromeSeamlessSso, forceRefresh, noDisableExtensions);
    })
    .catch(err => {
        if (err.name === "CLIError") {
            console.error(err.message);
            process.exit(2);
        } else {
            console.log(err);
        }
    });
