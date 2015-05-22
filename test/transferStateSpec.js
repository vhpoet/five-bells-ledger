/*global describe, it*/
'use strict';
const _ = require('lodash');
const sinon = require('sinon');
const app = require('../app');
const db = require('../services/db');
const config = require('../services/config');
const transferExpiryMonitor = require('../services/transferExpiryMonitor');
const dbHelper = require('./helpers/db');
const appHelper = require('./helpers/app');
const logHelper = require('@ripple/five-bells-shared/testHelpers/log');
const tweetnacl = require('tweetnacl');
const validate = require('@ripple/five-bells-shared/services/validate');
const hashJSON = require('@ripple/five-bells-shared/utils/hashJson');

const START_DATE = 1434412800000; // June 16, 2015 00:00:00 GMT

describe('Transfer State', function () {
  logHelper();

  beforeEach(function *() {
    appHelper.create(this, app);

    this.clock = sinon.useFakeTimers(START_DATE, 'Date');

    // Set up keys
    config.keys.ed25519 = {
      secret: 'iMx6i3D3acJPc4aJlK0iT/pkJP3T+Dqte9wg6hXpXEv08CpNQSm1J5AI6n/' +
        'QVBObeuQWdQVpgRQTAJzLLJJA/Q==',
      public: '9PAqTUEptSeQCOp/0FQTm3rkFnUFaYEUEwCcyyySQP0='
    };

    this.keyPair =
      tweetnacl.sign.keyPair.fromSecretKey(
        tweetnacl.util.decodeBase64(config.keys.ed25519.secret));

    // Define example data
    this.executedTransfer = _.cloneDeep(require('./data/transferExecuted'));
    this.transferWithExpiry = _.cloneDeep(require('./data/transferWithExpiry'));

    // Reset database
    yield dbHelper.reset();

    // Store some example data
    yield db.put(['accounts'], require('./data/accounts'));
  });

  afterEach(function *() {
    this.clock.restore();
  });

  describe('GET /transfers/:uuid/state', function() {

    it('should return a 404 if the transfer does not exist', function *() {
      yield this.request()
        .get('/transfers/03b7c787-e104-4390-934e-693072c6eda2/state')
        .expect(404)
        .end();
    });

    it('should return a 200 and a signed receipt including the message, ' +
      'messageHash, algorithm, public_key, and signature', function *() {

      yield db.create(['transfers'], this.executedTransfer);

      const stateReceipt = {
        id: this.formatId(this.executedTransfer, '/transfers/').id,
        state: this.executedTransfer.state
      };
      const stateReceiptHash = hashJSON(stateReceipt);
      const signature = tweetnacl.util.encodeBase64(
        tweetnacl.sign.detached(
          tweetnacl.util.decodeBase64(stateReceiptHash),
          this.keyPair.secretKey));

      yield this.request()
        .get('/transfers/' + this.executedTransfer.id + '/state')
        .expect(200, {
          message: stateReceipt,
          algorithm: 'ed25519-sha512',
          signer: config.server.base_uri,
          public_key: config.keys.ed25519.public,
          signature: signature
        })
        .end();
    });

    it('should return the correct state if the transfer is prepared',
      function *() {

      const transfer = _.cloneDeep(this.executedTransfer);
      transfer.state = 'prepared';

      yield db.create(['transfers'], transfer);

      const stateReceipt = {
        id: this.formatId(transfer, '/transfers/').id,
        state: transfer.state
      };
      const stateReceiptHash = hashJSON(stateReceipt);
      const signature = tweetnacl.util.encodeBase64(
        tweetnacl.sign.detached(
          tweetnacl.util.decodeBase64(stateReceiptHash),
          this.keyPair.secretKey));

      yield this.request()
        .get('/transfers/' + transfer.id + '/state')
        .expect(200, {
          message: stateReceipt,
          algorithm: 'ed25519-sha512',
          signer: config.server.base_uri,
          public_key: config.keys.ed25519.public,
          signature: signature
        })
        .end();
    });

    it('should return a valid TransferStateReceipt', function *() {
      const transfer = _.cloneDeep(this.executedTransfer);

      yield db.create(['transfers'], transfer);

      yield this.request()
        .get('/transfers/' + transfer.id + '/state')
        .expect(function(res) {
          let validationResult = validate('TransferStateReceipt', res.body);
          if (!validationResult.valid) {
            console.log(validationResult);
            throw new Error('Not a valid TransferStateReceipt');
          }
        })
        .end();
    });

    it('should return a rejected transfer receipt if the expires_at date ' +
      'has passed', function *() {

      const transfer = this.formatId(this.transferWithExpiry, '/transfers/');
      delete transfer.debits[0].authorization;

      yield this.request()
        .put('/transfers/' + this.transferWithExpiry.id)
        .send(transfer)
        .expect(201)
        .end();

      const stateReceipt = {
        id: transfer.id,
        state: 'rejected'
      };
      const stateReceiptHash = hashJSON(stateReceipt);
      const signature = tweetnacl.util.encodeBase64(
        tweetnacl.sign.detached(
          tweetnacl.util.decodeBase64(stateReceiptHash),
          this.keyPair.secretKey));

      // In production this function should be triggered by the worker started in app.js
      this.clock.tick(100);
      yield transferExpiryMonitor.processExpiredTransfers();

      yield this.request()
        .get('/transfers/' + this.transferWithExpiry.id + '/state')
        .expect(200, {
          message: stateReceipt,
          algorithm: 'ed25519-sha512',
          signer: config.server.base_uri,
          public_key: config.keys.ed25519.public,
          signature: signature
        })
        .end();

    });
  });
});