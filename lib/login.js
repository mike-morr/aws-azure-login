"use strict";

/* eslint-env browser */

const Promise = require("bluebird");
const inquirer = require("inquirer");
const phantom = require('phantom');
const zlib = Promise.promisifyAll(require("zlib"));
const AWS = require("aws-sdk");
const cheerio = require("cheerio");
const uuid = require("node-uuid");
const debug = require("debug")('aws-azure-login');
const CLIError = require("./CLIError");
const awsConfig = require("./awsConfig");

const sts = Promise.promisifyAll(new AWS.STS());

module.exports = profileName => {
    let profile, instance, page, pageResolve;
    return Promise.resolve()
        .then(() => awsConfig.getProfileConfig(profileName))
        .then(_profile => {
            profile = _profile;

            if (!profile) throw new CLIError(`Unknown profile '${profileName}'. You must configure it first.`);
            if (!profile.azure_tenant_id || !profile.azure_app_id_uri) throw new CLIError(`Profile '${profileName}' is not configured properly.`);

            debug("Creating PhantomJS instance");
            return phantom.create();
        })
        .then(_instance => {
            instance = _instance;

            debug("Creating PhantomJS page");
            return instance.createPage();
        })
        .then(_page => {
            page = _page;

            debug("Generating UUID for SAML request");
            const id = uuid.v4();
            const samlRequest = `
            <samlp:AuthnRequest xmlns="urn:oasis:names:tc:SAML:2.0:metadata" ID="id${id}" Version="2.0" IssueInstant="${new Date().toISOString()}" IsPassive="false" AssertionConsumerServiceURL="https://signin.aws.amazon.com/saml" xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol">
                <Issuer xmlns="urn:oasis:names:tc:SAML:2.0:assertion">${profile.azure_app_id_uri}</Issuer>
                <samlp:NameIDPolicy Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress"></samlp:NameIDPolicy>
            </samlp:AuthnRequest>
            `;

            debug("Generated SAML request", samlRequest);

            debug("Deflating SAML");
            return zlib.deflateRawAsync(samlRequest);
        })
        .then(samlBuffer => {
            debug("Encoding SAML in base64");
            const samlBase64 = samlBuffer.toString('base64');

            const url = `https://login.microsoftonline.com/${profile.azure_tenant_id}/saml2?SAMLRequest=${encodeURIComponent(samlBase64)}`;
            debug("Loading Azure login page", url);
            return page.open(url);
        })
        .then(status => {
            debug("Page opened");
            if (status !== "success") throw new CLIError("Failed to load Azure login page!");

            page.on("onLoadFinished", () => {
                debug("onLoadFinished event triggered");
                if (pageResolve) {
                    pageResolve();
                    pageResolve = null;
                }
            });

            debug('Requesting user credentials');
            return inquirer.prompt([{
                name: "username",
                message: "Username:",
                default: profile.azure_default_username
            }, {
                name: "password",
                message: "Password:",
                type: "password"
            }]);
        })
        .then(answers => {
            debug("User input captured. Populating form in PhantomJS");
            return page.evaluate(function (username, password) {
                document.forms[0].login.value = username;
                document.forms[0].passwd.value = password;
                document.forms[0].submit();
            }, answers.username, answers.password);
        })
        .then(() => {
            debug("Waiting for page to load");
            return new Promise((resolve, rejected) => {
                debug("Page loaded");
                pageResolve = resolve;
            });
        })
        .then(() => {
            debug("Fetching page content");
            return page.property("content");
        })
        .then(contentText => {
            debug("Content fetched", contentText);

            debug("Parsing content");
            const content = cheerio.load(contentText);

            debug("Looking for error message");
            const errorMessage = content("#recover_container h1").text();
            if (errorMessage) throw new CLIError(errorMessage);

            debug("Looking for MFA request");
            if (content("#tfa_code_inputtext").length) {
                debug("MFA requested. Prompting user for verification code");
                return inquirer.prompt([{
                    name: "verificationCode",
                    message: "Verification Code:"
                }])
                    .then(answers => {
                        debug('Received code. Populating form in PhantomJS');
                        return page.evaluate(function (verificationCode) {
                            document.getElementById("tfa_code_inputtext").value = verificationCode;
                            document.getElementById("tfa_signin_button").click();

                            // Error handling is done client-side, so check to see if the error message displays.
                            var errorBox = document.getElementById('tfa_client_side_error_text');
                            if (errorBox.style.display === "block") {
                                return errorBox.textContent.trim();
                            }
                        }, answers.verificationCode);
                    })
                    .then(errorMessage => {
                        if (errorMessage) throw new CLIError(errorMessage);

                        debug("Waiting for page to load");
                        return new Promise((resolve, rejected) => { // Wait for the page to load
                            debug("Page loaded");
                            pageResolve = resolve;
                        });
                    })
                    .then(() => {
                        debug("Fetching page content");
                        return page.property("content");
                    })
                    .then(contentText => {
                        debug("Content fetched", contentText);

                        debug("Parsing content");
                        return cheerio.load(contentText);
                    });
            }

            return content;
        })
        .then(content => {
            debug("Looking for SAML assertion in input field");
            const assertion = content("input").val();
            debug("Found SAML assertion", assertion);

            debug("Converting assertion from base64 to ASCII");
            const samlText = new Buffer(assertion, 'base64').toString("ascii");
            debug("Converted", samlText);

            debug("Pasring SAML XML");
            const saml = cheerio.load(samlText, { xmlMode: true });

            debug("Looking for role SAML attribute");
            const roleAndPrincipal = saml("Attribute[Name='https://aws.amazon.com/SAML/Attributes/Role']").text();
            debug("Found attribute", roleAndPrincipal);

            const parts = roleAndPrincipal.split(",");
            const roleArn = parts[0].trim();
            const principalArn = parts[1].trim();

            console.log(`Assuming role ${roleArn}`);
            return sts.assumeRoleWithSAMLAsync({
                PrincipalArn: principalArn,
                RoleArn: roleArn,
                SAMLAssertion: assertion
            });
        })
        .then(res => {
            return awsConfig.setProfileCredentials(profileName, {
                aws_access_key_id: res.Credentials.AccessKeyId,
                aws_secret_access_key: res.Credentials.SecretAccessKey,
                aws_session_token: res.Credentials.SessionToken
            });
        })
        .finally(() => {
            debug("Exiting PhantomJS");
            return instance.exit();
        });
};