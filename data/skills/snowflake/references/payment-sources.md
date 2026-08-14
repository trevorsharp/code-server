# Payment Sources

Names, availability, and semantics can drift; use corpus discovery and live Snowflake verification before relying on an object.

## Environment Routing

- Production payment events: `TRANSACTION.ADHOC_EVENTS.VW_EVNT_*`
- Test and UAT Kafka events: `KAFKAEVENTS_TEST_UAT.EVENTABLE.VW_ADHOC_EVENTS_TEST_PARSED`, filtered by `EVENT_NAME`
- Production `TRANSACTION.ADHOC_EVENTS` views contain `ENVIRONMENT = 'production'` events.

## Evidence And Source Routing

Choose evidence according to the state being proved:

| Question | Candidate evidence | Important limit |
| --- | --- | --- |
| Payment selection | PurchasePay `PaymentSelectionMade`, legacy Financial Accounts Jobs `AccountSelected`, or `FINANCEGROUP.FINANCE_ANALYTICS.MSG_PURCHASE_PAYMENTS` | Does not prove initiation or movement |
| Consent | Consent API records or PurchasePayments `ConsentsSubmitted` | Customer-grain consent may not identify a purchase; require temporal corroboration |
| Payment lifecycle | Financial Accounts Jobs `PaymentInitiated`, `PaymentAuthorized`, `PaymentSucceeded`, `PaymentFailed`, and `PaymentCancelled` | Failures before initiation cannot appear |
| Collection or ledger posting | PurchasePay `PaymentBalanceEntryPosted` and `TRANSACTION.PUBLIC.VW_PURCHASEPAY_LEDGER` | Vehicle-purchase entries are order accounting, not payment collection |
| Processor movement | Plaid transfer lifecycle or processor-specific sources | Selection, consent, and HTTP success do not prove transfer creation |
| STC negative-equity card authorization | SellToCarvana `AuthHold_Enrolled` and `AuthHold_EnrollmentFailed` | `Enrolled` proves hold creation, not capture |
| Seller payout | PurchasePay or Plaid ACH payout sources | This is not the STC negative-equity card flow |

For historical purchase state, prefer durable event history over current cart projections. Useful sources include `FINANCEGROUP.FINANCE_ANALYTICS.MSG_PURCHASE_PAYMENTS`, `FINANCEGROUP.FINANCE_ANALYTICS.FACT_FUNDS_VERIFICATION_REQUIREMENTS`, and these `ENTERPRISE_APPLICATION_DS.AUTO_LOADER` transaction-queue views: `VW_TRANSACTION_QUEUE_ORDER_PLACED`, `VW_TRANSACTION_QUEUE_PURCHASE_ROLLED_BACK`, `VW_TRANSACTION_QUEUE_PAYMENT_COLLECTION_DETAIL`, and `VW_TRANSACTION_QUEUE_PAYMENT_COLLECTION_SUMMARY`. Prefer these curated objects when raw databases are unauthorized.

## PurchasePay

- Ledger: `TRANSACTION.PUBLIC.VW_PURCHASEPAY_LEDGER`
- Balance events in `TRANSACTION.ADHOC_EVENTS`:
  - `VW_EVNT_PAYMENTS_PURCHASEPAY_CARVANA_PAYMENTS_PURCHASEPAY_BALANCEADJUSTMENTBALANCEENTRYPOSTED_V1`
  - `VW_EVNT_PAYMENTS_PURCHASEPAY_CARVANA_PAYMENTS_PURCHASEPAY_PAYMENTBALANCEENTRYPOSTED_V1`
  - `VW_EVNT_PAYMENTS_PURCHASEPAY_CARVANA_PAYMENTS_PURCHASEPAY_PAYOUTBALANCEENTRYPOSTED_V1`
  - `VW_EVNT_PAYMENTS_PURCHASEPAY_CARVANA_PAYMENTS_PURCHASEPAY_VEHICLEPURCHASEBALANCEENTRYPOSTED_V1`
- Payment-method eligibility event: `TRANSACTION.ADHOC_EVENTS.VW_EVNT_PAYMENTS_PURCHASEPAY_CARVANA_PAYMENTS_PURCHASEPAY_GETELIGIBLEPAYMENTMETHODS_V1`

## Plaid

- Core tables in `AZURE_SQL_ADS.PLAID`: `PLAID_ACCOUNT`, `PLAID_ITEM`, `PLAID_TRANSACTION`, `PLAID_DEACTIVATION`, `PLAID_IDENTITY_NAME`, `PLAID_IDENTITY_ADDRESS`, `PLAID_IDENTITY_EMAIL`, `PLAID_IDENTITY_PHONE`, `PLAID_REQUEST_RESPONSE`, `PLAID_PRODUCT`
- Credit scores: `AZURE_SQL_ADS.CREDIT_APPLICATION.PLAID_SCORE`
- Transfers: `ACCOUNTINGGROUP.CASHIERING.VW_PLAIDLINK_TRANSFER`
- Kafka events in `TRANSACTION.ADHOC_EVENTS`: `VW_EVNT_PAYMENTS_PLAIDLINK_CARVANA_PAYMENTS_PLAIDLINK_{TRANSFERINITIATED,TRANSFERSETTLED,TRANSFERFAILED,TRANSFEREVENTS,REALTIMEPAYMENTTRANSFERELIGIBILITY}_V1`
- PurchaseUI clickstream in `TRANSACTION.CLICKSTREAM_EVENTS`: `VW_EVNT_TXN_PURCHASEUI_{PAYMENTS_PLAID_FLOW,PAYMENTS_BAV_PLAID_FLOW,PLAID_BAV_VERIFIED,PLAID_BAV_ENTER_CODE,PLAID_BAV_DEPOSIT_FAILED,PP_PLAID_SUCCESS,PP_PLAID_ERROR,PP_PLAID_INFO}`
- `PLAID_TRANSACTION` is especially large; use a selective date predicate.

## Digital Wallets

- Current wallet event source as of 2026-08-14: `TRANSACTION.CLICKSTREAM_EVENTS.VW_EVNT_TXN_PURCHASEUI_PP_TRANSFER_SCHEDULE_PAO_MODAL_DIGITAL_WALLETS`; data begins 2026-05-26.
- `TRANSACTION.CLICKSTREAM_EVENTS.VW_EVNT_TXN_PURCHASEUI_PP_DOWN_PAYMENT_DIGITAL_WALLETS` became stale during a staggered May-July 2026 shutdown.
- Down-payment selection tiles and `pp_complete_purchase_digital_wallet_*` were Datadog RUM-only; no Snowflake view was known at compilation time.
- Wallet-support telemetry has appeared on down-payment `PP_LOAD` events at `CUSTOM_ATTRIBUTES:metadata:digitalWalletSupportSource`, with observed values `ready` and `timeout`.
- `timeout` records censoring at the UI threshold, historically three seconds. It does not record eventual readiness or successful resolution duration. Recheck current code before interpreting recent data; this binary telemetry cannot establish late-support probability, device causality, or an optimal timeout.

## Stripe Decline Observations

`VERIFICATIONS.FINANCE_ANALYTICS.VW_TBL_CARD_ELIGIBILITY.INPUT_STRIPE_DECLINE_CODE` contains eligibility-calculator observations, not an authoritative payment-attempt ledger.

- Exclude blanks and the literal string `'null'`.
- Join `CARD_ELIGIBILITY_ID` to `VERIFICATIONS.FINANCE_ANALYTICS.VW_TBL_CARD_ELIGIBILITY_CARVANA_IDENTITY_ID` when `INTENT_TYPE` is needed.
- Validate join cardinality or select the latest relevant ETL row before aggregation.
- Treat counts as decline-code observations, not necessarily unique failed payments. Do not use this source alone for conversion or processor incident rates.

## Payment Lifecycle

Financial Accounts Jobs events use `TRANSACTION.ADHOC_EVENTS.VW_EVNT_PAYMENTS_FINANCIALACCOUNTSJOBS_CARVANA_PAYMENTS_FINANCIALACCOUNTSJOBS_{EVENT}_V1`, where known events include:

- `PAYMENTINITIATED`, `PAYMENTAUTHORIZED`, `PAYMENTSUCCEEDED`, `PAYMENTFAILED`, `PAYMENTCANCELLED`, `PAYMENTDISPUTED`, `PAYMENTREFUNDINITIATED`
- `ACCOUNTSELECTED`, `PURCHASEENTRY`, `PLAIDACCOUNTLINKED`
- `MICRODEPOSITREQUESTED`, `MICRODEPOSITPOSTED`, `MICRODEPOSITFAILED`

Other lifecycle sources:

- Payout checks: `AZURE_SQL_ADS.PAYOUT.INVOICE_PAYOUT_CHECK`
- Payments Carma events in `TRANSACTION.ADHOC_EVENTS`: `VW_EVNT_PAYMENTS_PAYMENTSCARMA_REFUNDPAYMENT`, `VW_EVNT_PAYMENTS_PAYMENTSCARMA_MANUALLYADDEDSHIPPINGFEECREDIT`, `VW_EVNT_PAYMENTS_PAYMENTSCARMA_MANUALLYREMOVEDSHIPPINGFEECREDIT`
- Account validation: `TRANSACTION.ADHOC_EVENTS.VW_EVNT_PAYMENTS_ACCOUNTVALIDATION_CARVANA_PAYMENTS_ACCOUNTVALIDATION_VALIDATIONRESULT_V1`

## TORQ Refunds

- Tables in `AZURE_SQL_ADS.TREASURY_OPS_REFUND`: `TBL_CASE`, `TBL_CASE_AUDIT`, `TBL_CASE_HISTORY`, `TBL_CASE_STATE`, `TBL_CART_DETAIL`, `TBL_CART_DETAIL_AUDIT`, `TBL_CUSTOMER_DETAIL`, `TBL_CUSTOMER_DETAIL_AUDIT`, `TBL_PURCHASE_PAYMENT_AUDIT`, `TBL_REVIEW_TYPE`, `TBL_AI_REFUND_SUMMARY`
- Curated views: `FINANCEGROUP.TREASURY_OPS_REFUND.VW_TBL_CASE`, `FINANCEGROUP.TREASURY_OPS_REFUND.VW_TBL_CART_DETAIL`

## Sell To Carvana Authorization Holds

For STC negative-equity card authorization attempts, union:

- `SELLTOCARVANA.ADHOC_EVENTS.VW_EVNT_STC_PAYMENT_STC_PAYMENT_AUTHHOLD_ENROLLED`
- `SELLTOCARVANA.ADHOC_EVENTS.VW_EVNT_STC_PAYMENT_STC_PAYMENT_AUTHHOLD_ENROLLMENTFAILED`

Deduplicate each `EVENT_ID` to the latest `SNOW_LOADED_DATETIME_UTC` before aggregation. Count the union as attempts, and report both event volume and distinct acquisition or payment grain because retries can inflate raw failures. Use `USER_ID` plus `ACQUISITION_NAME` only as a retry grouping after validating coverage. Use `CONVERT_TIMEZONE` before applying Phoenix-local comparison windows; `CURRENT_DATE('America/Phoenix')` is invalid Snowflake syntax. `AuthHold_Enrolled` proves hold creation, not capture, and `ACQUISITION_NAME` is not a proven market-enrichment key.

## Retail And Cashiering

- Retail sales: `ACCOUNTINGGROUP.RETAIL.VW_RETAILSALE`
- Retail payments: `AZURE_SQL_ADS.RETAIL_SALE.RETAIL_PAYMENT`
- Combined cashiering events: `TRANSACTION.PUBLIC.VW_EVNT_PAYMENTS_CASHIERING_CARVANA_PAYMENTS_CASHIERING_COMBINED`
- Individual cashiering events use `TRANSACTION.ADHOC_EVENTS.VW_EVNT_PAYMENTS_CASHIERING_CARVANA_PAYMENTS_CASHIERING_{EVENT}_V1`, where known events include `MARKCHECKRECEIVED`, `MARKCHECKDEPOSITED`, `MARKCHECKBOUNCED`, `MARKCHECKRETURNED`, `MARKCHECKFLAGGEDFORREVIEW`, `MARKCHECKEXPECTEDFUNDS`, `UPDATECHECK`, `MARKWIREDEPOSITED`, and `MARKWIREEXPECTEDFUNDS`.

## Purchase Funnel

- PurchaseUI clickstream in `TRANSACTION.CLICKSTREAM_EVENTS`: `VW_EVNT_TXN_PURCHASEUI_PP_LOAD`, `VW_EVNT_TXN_PURCHASEUI_PP_COMPLETE`, `VW_EVNT_TXN_PURCHASEUI_PP_COMPLETE_ERROR`, `VW_EVNT_TXN_PURCHASEUI_PP_LOAD_ERROR`, `VW_EVNT_TXN_PURCHASEUI_PP_LOAD_TIME`, `VW_EVNT_TXN_PURCHASEUI_PP_FAILURE`
- Payment type added: `ANALYTICS_PROD.FUNNEL_EVENTS.EDW_PAYMENT_TYPE_ADDED`

### PurchaseUI Clickstream Contract

Eventable PurchaseUI events commonly materialize as `TRANSACTION.CLICKSTREAM_EVENTS.VW_EVNT_TXN_PURCHASEUI_<NORMALIZED_EVENT>`, backed by `TRANSACTION_RAW.CLICKSTREAM_EVENTS.<NORMALIZED_EVENT>`. This is a convention, not a guarantee: some emitted events are not materialized, and renamed events can leave stale views. Profile minimum and maximum timestamps and representative `CUSTOM_ATTRIBUTES` before use.

`VW_EVNT_TXN_PURCHASEUI_PP_LOAD` exposes top-level `USER_ID`, not `CUSTOMER_ID`. Treat browser-cookie and correlation identifiers as session or diagnostic aids, not interchangeable customer identifiers, and state deduplication grain explicitly.

In authenticated PurchaseUI RUM, `usr.id` has represented CarvanaUserId and `usr.userBcid` BrowserCookieId. Revalidate this in current application code before applying it to anonymous sessions or other applications.

Historical card-entry analysis requires date-aware event lineage. The legacy click was `pp_down_payment_select_option_new_card`; the newer click is `pp_down_payment_select_card_entry_tile`, with migration overlap. `pp_modal_opened` for `card-entry-modal` is not a reliable current-flow endpoint. Profile event coverage by date rather than applying current code identifiers to historical periods.

## Cosmos Payment Data

- Curated views: `COSMOS_DB.PAYMENTS.VW_CASHIERING_FUNDS`, `COSMOS_DB.PAYMENTS.VW_GIFTS_AND_REIMBURSEMENTS_REQUESTS`, `COSMOS_DB.PAYMENT_ATTRIBUTES.VW_PAYMENT_ATTRIBUTES`, `COSMOS_DB.ACCOUNT_META_DATA.VW_CARD_ELIGIBILITY`, `COSMOS_DB.ACCOUNT_META_DATA.VW_PAYMENT_METHOD_ELIGIBILITY`, `COSMOS_DB.ACCOUNT_META_DATA.VW_STC_CARD_ELIGIBILITY`, `COSMOS_DB.ACCOUNT_META_DATA.VW_STC_PAYMENT_METHOD_ELIGIBILITY`, `COSMOS_DB.STC_PAYMENT.VW_INVOICES`
- Raw tables: `COSMOS_DB_RAW.PAYMENTS.CASHIERING_FUNDS`, `COSMOS_DB_RAW.PAYMENTS.GIFTS_AND_REIMBURSEMENTS_REQUESTS`, `COSMOS_DB_RAW.PAYMENT_ATTRIBUTES.PAYMENT_ATTRIBUTES`, `COSMOS_DB_RAW.ACCOUNT_META_DATA.PAYMENT_METHOD_ELIGIBILITY`, `COSMOS_DB_RAW.STC_PAYMENT.INVOICES`
- Always filter curated state-document views with `AUDIT_IS_CURRENT = TRUE`.
- If the view has `IS_EVENT`, also use `COALESCE(IS_EVENT, FALSE) = FALSE`. A bare `IS_EVENT = FALSE` incorrectly drops valid state documents created before April 2024.

## Experiments

- `SHARED.SPLIT_TEST.TBL_BUCKET_ASSIGNMENT`
- `SHARED.SPLIT_TEST.TBL_BUCKET`
- `SHARED.SPLIT_TEST.TBL_EXPERIMENT`

Join assignment `BUCKET_ID` to bucket `BUCKET_ID`, then bucket `EXPERIMENT_ID` to experiment `EXPERIMENT_ID`. Match the event's experiment identifier to assignment `IDENTIFIER`, require `ROW_LOADED_DATETIME_UTC <= event_timestamp`, and select the latest eligible assignment per measured event. Identifier meaning is experiment-specific; validate it before joining customer, PurchaseUI user, visitor, or browser-cookie identifiers.

For authenticated PurchaseUI experiments identified by CarvanaUserId, prefer `SHARED.EXPERIMENTATION.TBL_IDENTIFIER_ASSIGNMENT_CARVANA_USER_ID` filtered by `EXPERIMENT_KEY` before scanning generic enhanced-assignment tables. Normalize UUID case when matching identifiers.

## Common Columns

- Common event dates are `EVENT_TIMESTAMP` and `CREATED_AT`; verify before querying.
- Common customer keys are `USER_ID` and `CUSTOMER_ID`; verify grain and key meaning before joining.
