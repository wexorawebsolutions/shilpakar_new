import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {verifyWebhookMac,isVerifiedPaid} from './provider.js';

test('authentic signed webhook passes, tampering fails',()=>{
  const salt='test-salt'; const data={status:'Credit',payment_id:'MOJO123',payment_request_id:'pr123',amount:'299.00'};
  const value=Object.entries(data).sort(([a],[b])=>a.toLowerCase().localeCompare(b.toLowerCase())).map(([,v])=>v).join('|');
  const mac=crypto.createHmac('sha1',salt).update(value).digest('hex');
  assert.equal(verifyWebhookMac({...data,mac},salt),true);
  assert.equal(verifyWebhookMac({...data,amount:'1.00',mac},salt),false);
});
test('server verification rejects mismatched amount, request, and pending payment',()=>{
  const request={id:'abc123',amount:'299.00'};
  const payment={id:'MOJO123456',status:true,payment_request:'https://api.instamojo.com/v2/payment_requests/abc123/'};
  const input={payment,request,requestId:'abc123',paymentId:'MOJO123456',amountPaise:29900};
  assert.equal(isVerifiedPaid(input),true);
  assert.equal(isVerifiedPaid({...input,amountPaise:99900}),false);
  assert.equal(isVerifiedPaid({...input,payment:{...payment,status:null}}),false);
  assert.equal(isVerifiedPaid({...input,payment:{...payment,payment_request:'https://api.instamojo.com/v2/payment_requests/evil/'}}),false);
});
