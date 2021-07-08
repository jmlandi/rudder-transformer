// import { getEventSchema } from "./trackingPlan";
const Ajv = require("ajv");

const NodeCache = require("node-cache");
const _ = require("lodash");
const trackingPlan = require("./trackingPlan");

const eventSchemaCache = new NodeCache();
const logger = require("../logger");

const defaultOptions = {
  // strict mode options (NEW)
  strictRequired: true,
  // validation and reporting options:
  allErrors: true,
  verbose: true
  // options to modify validated data:
  // removeAdditional: false, // "all" - it purges extra properties from event,
  // useDefaults: false // *
};

const violationTypes = {
  RequiredMissing: "Required-Missing",
  DatatypeMismatch: "Datatype-Mismatch",
  AdditionalProperties: "Additional-Properties",
  UnknownViolation: "Unknown-Violation",
  UnplannedEvent: "Unplanned-Event"
};

// TODO : merge defaultOptions with options from sourceConfig
const ajv = new Ajv(defaultOptions);

// Ajv meta load to support draft-04/06/07/2019
//const Ajv2019 = require("ajv/dist/2019");

// TODO: handle various json schema versions
// const ajv = new Ajv2019(defaultOptions);
// const migrate = require("json-schema-migrate");
// const draft6MetaSchema = require("ajv/dist/refs/json-schema-draft-06.json");
// ajv.addMetaSchema(draft6MetaSchema);
// const draft7MetaSchema = require("ajv/dist/refs/json-schema-draft-07.json");
// ajv.addMetaSchema(draft7MetaSchema);
//
// function validateSchema(schemaRules) {
//   const schemaCopy = JSON.parse(JSON.stringify(schemaRules));
//   if (
//       schemaCopy.hasOwnProperty("$schema") &&
//       schemaCopy["$schema"].includes("draft-04")
//   ) {
//     migrate.draft2019(schemaCopy);
//     //migrate.draft7(schemaCopy);
//   }
//   const valid = ajv.validateSchema(schemaCopy, true);
//   return [valid, schemaCopy];
// }

// safety check to check if event has TpID,TpVersion associated
function checkForPropertyMissing(property) {
  if (!(property && property !== ""))
    throw `${property} doesnt exist for event`;
}

function eventSchemaHash(tpId, tpVersion, eventType, eventName) {
  return `${tpId}::${tpVersion}::${eventType}::${eventName}`;
}

// interface ErrorObject {
//   keyword: string // validation keyword.  ex: required
//   instancePath: string // JSON Pointer to the location in the data instance (e.g., `"/prop/1/subProp"`).
//   schemaPath: string // JSON Pointer to the location of the failing keyword in the schema ex
//   params: object // type is defined by keyword value, see below
//                  // params property is the object with the additional information about error
//                  // it can be used to generate error messages
//                  // (e.g., using [ajv-i18n](https://github.com/ajv-validator/ajv-i18n) package).
//                  // See below for parameters set by all keywords.
//   propertyName?: string // set for errors in `propertyNames` keyword schema.
//                         // `instancePath` still points to the object in this case.
//   message?: string // the error message (can be excluded with option `messages: false`).
//   // Options below are added with `verbose` option:
//   schema?: any // the value of the failing keyword in the schema.
//   parentSchema?: object // the schema containing the keyword.
//   data?: any // the data validated by the keyword.
// }
// {
//                 "instancePath": "",
//                 "schemaPath": "#/required",
//                 "keyword": "required",
//                 "params": {
//                     "missingProperty": "price"
//                 },
//                 "message": "must have required property 'price'",
//                 "schema": [
//                     "product",
//                     "price",
//                     "amount"
//                 ],
//                "parentSchema":{} //full schema
//                "data":{} //full properties object
// }
// {
//                 "instancePath": "/amount",
//                 "schemaPath": "#/properties/amount/type",
//                 "keyword": "type",
//                 "params": {
//                     "type": [
//                         "number"
//                     ]
//                 },
//                 "message": "must be number",
//                 "schema": [
//                     "number"
//                 ],
//                 "parentSchema": {
//                     "type": [
//                         "number"
//                     ]
//                 },
//                 "data": true
//             }
async function validate(event) {
  try {
    checkForPropertyMissing(event.metadata.trackingPlanId);
    checkForPropertyMissing(event.metadata.trackingPlanVersion);
    checkForPropertyMissing(event.metadata.workspaceId);
    // const sourceTpConfig = event.metadata.sourceTpConfig;

    const eventSchema = await trackingPlan.getEventSchema(
      event.metadata.trackingPlanId,
        event.metadata.trackingPlanVersion,
      event.message.type,
      event.message.event,
      event.metadata.workspaceId
    );
    // If no eventSchema, returns a validationError
    // if (!eventSchema[0]) return [eventSchema[1]];
    // UnPlanned event case - since no event schema is found. Violation is raised
    if (!eventSchema || eventSchema === {}) {
      rudderValidationError = {
        type: violationTypes.UnplannedEvent,
        message: `no schema for eventName : ${event.message.event}, eventType : ${event.message.type} in trackingPlanID : ${event.metadata.trackingPlanId}::${event.metadata.trackingPlanVersion}`,
        meta: {}
      };
      return [rudderValidationError];
    }
    // const [isSchemaValid, schemaCopy] = validateSchema(eventSchema);
    // const validateEvent = ajv.compile(schemaCopy);
    // Error: schema with key or id "http://rudder.com/order-completed" already exists
    const schemaHash = eventSchemaHash(
      event.metadata.trackingPlanId,
      event.metadata.trackingPlanVersion,
      event.message.type,
      event.message.event
    );
    let validateEvent = eventSchemaCache.get(schemaHash);
    if (!validateEvent) {
      validateEvent = ajv.compile(eventSchema);
      eventSchemaCache.set(schemaHash, validateEvent);
    }
    logger.debug(JSON.stringify(eventSchemaCache.getStats()));

    const valid = validateEvent(event.message.properties);
    if (valid) {
      // console.log(`${JSON.stringify(event.message.properties)} is Valid!`);
      return [];
    }
    // console.log(`${event} Invalid: ${ajv.errorsText(validateEvent.errors)}`);
    // throw new Error()
    var validationErrors = validateEvent.errors.map(function(error) {
      var rudderValidationError;
      switch (error.keyword) {
        case "required":
          // requirement not fulfilled.
          rudderValidationError = {
            type: violationTypes.RequiredMissing,
            message: error.message,
            meta: {
              instacePath: error.instancePath,
              schemaPath: error.schemaPath,
              missingProperty: error.params.missingProperty
            }
          };
          break;
        case "type":
          rudderValidationError = {
            type: violationTypes.DatatypeMismatch,
            message: error.message,
            meta: {
              instacePath: error.instancePath,
              schemaPath: error.schemaPath
            }
          };
          break;
        case "additionalProperties":
          rudderValidationError = {
            type: violationTypes.AdditionalProperties,
            message: `${error.message} : ${error.params.additionalProperty}`,
            meta: {
              instacePath: error.instancePath,
              schemaPath: error.schemaPath
            }
          };
          break;
        default:
          rudderValidationError = {
            type: violationTypes.UnknownViolation,
            message: "Unexpected error during event validation",
            meta: {
              error: error
            }
          };
      }
      return rudderValidationError;
    });
    return validationErrors;
  } catch (error) {
    // logger.error(`Failed during event validation : ${error}`);
    // stats.increment("get_trackingplan.error");
    throw error;
  }
}

exports.validate = validate;
