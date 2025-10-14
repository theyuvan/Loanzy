# 📊 Activity Score System - Architecture & Data Flow

## System Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     Frontend (React + Vite)                     │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌──────────────────────────────────────────────────────┐     │
│  │         TransactionHistory Component                  │     │
│  │  ┌────────────────────────────────────────────────┐  │     │
│  │  │  • Activity Score Card                         │  │     │
│  │  │  • Sent/Received Breakdown                     │  │     │
│  │  │  • Transaction List (All/Sent/Received tabs)   │  │     │
│  │  │  • Refresh Button                              │  │     │
│  │  │  • Voyager Links                               │  │     │
│  │  └────────────────────────────────────────────────┘  │     │
│  └──────────────────────────────────────────────────────┘     │
│                           │                                     │
│                           │ axios.get()                         │
│                           ↓                                     │
└─────────────────────────────────────────────────────────────────┘
                            │
                            │ HTTP Request
                            │
┌───────────────────────────┼─────────────────────────────────────┐
│                           ↓                                     │
│                  Backend (Express.js)                           │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌──────────────────────────────────────────────────────┐     │
│  │              Activity Routes                          │     │
│  │  ┌────────────────────────────────────────────────┐  │     │
│  │  │  GET /api/activity/:wallet                     │  │     │
│  │  │  GET /api/activity/:wallet/transactions        │  │     │
│  │  │  GET /api/activity/:wallet/detailed            │  │     │
│  │  └────────────────────────────────────────────────┘  │     │
│  └──────────────────────────────────────────────────────┘     │
│                           │                                     │
│                           │ Call service                        │
│                           ↓                                     │
│  ┌──────────────────────────────────────────────────────┐     │
│  │          Transaction Fetcher Service                  │     │
│  │  ┌────────────────────────────────────────────────┐  │     │
│  │  │  • fetchTransactions()                         │  │     │
│  │  │  • separateSentReceived()                      │  │     │
│  │  │  • calculateActivityScore()                    │  │     │
│  │  │  • getTxMetrics()                              │  │     │
│  │  └────────────────────────────────────────────────┘  │     │
│  └──────────────────────────────────────────────────────┘     │
│                           │                                     │
│                           │ RPC Call                            │
│                           ↓                                     │
└─────────────────────────────────────────────────────────────────┘
                            │
                            │ HTTPS Request
                            │
┌───────────────────────────┼─────────────────────────────────────┐
│                           ↓                                     │
│                  Blast API RPC Provider                         │
│         https://starknet-sepolia.public.blastapi.io             │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  • getBlockNumber()                                             │
│  • getTransactionReceipt()                                      │
│  • Filter events by wallet address                             │
│  • Return transaction data                                      │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
                            │
                            │ Blockchain Query
                            ↓
┌─────────────────────────────────────────────────────────────────┐
│                  Starknet Sepolia Testnet                       │
│                      (Blockchain)                               │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  • Block data                                                   │
│  • Transaction receipts                                         │
│  • Transfer events                                              │
│  • Contract calls                                               │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## Data Flow Diagram

```
┌──────────────┐
│ User Clicks  │
│   Refresh    │
└──────┬───────┘
       │
       ↓
┌──────────────────────────────────────────────────────────┐
│ Frontend: TransactionHistory Component                   │
│                                                           │
│ 1. Get wallet address from props                         │
│ 2. Call: axios.get(`/api/activity/${walletAddress}`)    │
│ 3. Set loading state = true                              │
└──────┬────────────────────────────────────────────────────┘
       │
       │ HTTP GET Request
       ↓
┌──────────────────────────────────────────────────────────┐
│ Backend: activityRoutes.js                               │
│                                                           │
│ 1. Receive GET /api/activity/:walletAddress              │
│ 2. Validate wallet address format                        │
│ 3. Call transactionFetcher.fetchTransactions()          │
└──────┬────────────────────────────────────────────────────┘
       │
       ↓
┌──────────────────────────────────────────────────────────┐
│ Backend: transactionFetcher.js                           │
│                                                           │
│ Step 1: Get Current Block Number                         │
│ ├─→ provider.getBlockNumber()                            │
│ └─→ Calculate fromBlock (current - 1000)                 │
│                                                           │
│ Step 2: Fetch Transactions                               │
│ ├─→ Scan blocks from fromBlock to current                │
│ ├─→ Filter transfers involving wallet                    │
│ └─→ Extract: txHash, from, to, amount, blockNumber      │
│                                                           │
│ Step 3: Separate Sent/Received                           │
│ ├─→ If wallet == from_address → Sent                     │
│ ├─→ If wallet == to_address → Received                   │
│ └─→ Calculate total amounts                              │
│                                                           │
│ Step 4: Calculate Metrics                                │
│ ├─→ Total volume (sent + received)                       │
│ ├─→ Transaction count                                    │
│ ├─→ Unique addresses                                     │
│ └─→ Recent transactions (last 100 blocks)                │
│                                                           │
│ Step 5: Calculate Activity Score                         │
│ ├─→ volumeScore = (totalVol / 100) × 1000 × 0.40        │
│ ├─→ freqScore = (txCount / 50) × 1000 × 0.30            │
│ ├─→ divScore = (unique / 10) × 1000 × 0.20              │
│ ├─→ recScore = (recent > 0) × 1000 × 0.10               │
│ └─→ finalScore = sum of all scores                       │
│                                                           │
│ Step 6: Format Response                                  │
│ ├─→ Format amounts (wei → STRK)                          │
│ ├─→ Add timestamps                                       │
│ └─→ Return JSON                                           │
└──────┬────────────────────────────────────────────────────┘
       │
       │ JSON Response
       ↓
┌──────────────────────────────────────────────────────────┐
│ Backend: activityRoutes.js                               │
│                                                           │
│ 1. Receive data from transactionFetcher                  │
│ 2. Wrap in success response                              │
│ 3. Send to frontend                                      │
└──────┬────────────────────────────────────────────────────┘
       │
       │ HTTP Response
       ↓
┌──────────────────────────────────────────────────────────┐
│ Frontend: TransactionHistory Component                   │
│                                                           │
│ 1. Receive JSON response                                 │
│ 2. Update state: setActivityData(data)                   │
│ 3. Set loading = false                                   │
│ 4. Trigger onScoreCalculated(score) callback             │
│ 5. Render UI with new data                               │
└──────┬────────────────────────────────────────────────────┘
       │
       ↓
┌──────────────────────────────────────────────────────────┐
│ Display to User                                           │
│                                                           │
│ ┌────────────────────────────────────────────────────┐  │
│ │  Activity Score: 650                                │  │
│ │                                                      │  │
│ │  Total: 25 | Sent: 10 | Received: 15 | Vol: 12.5   │  │
│ ├────────────────────────────────────────────────────┤  │
│ │  📤 Sent: 5.00 STRK                                 │  │
│ │  📥 Received: 7.50 STRK                             │  │
│ ├────────────────────────────────────────────────────┤  │
│ │  📋 All (25) | 📤 Sent (10) | 📥 Received (15)      │  │
│ │                                                      │  │
│ │  📤 0x123...abc → 0xdef...ghi  -1.00 STRK          │  │
│ │  📥 0xabc...def → 0x123...abc  +2.50 STRK          │  │
│ └────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────┘
```

---

## Score Calculation Flow

```
┌─────────────────────────────────────┐
│  Raw Transaction Data               │
│                                     │
│  • 25 transactions                  │
│  • 50 STRK total volume             │
│  • 8 unique addresses               │
│  • 3 recent transactions            │
└─────────┬───────────────────────────┘
          │
          ↓
┌─────────────────────────────────────┐
│  Calculate Component Scores         │
│                                     │
│  ┌───────────────────────────────┐ │
│  │ Volume Score (40% weight)     │ │
│  │                               │ │
│  │ score = (50 / 100) × 1000     │ │
│  │       = 500                   │ │
│  │ weighted = 500 × 0.40         │ │
│  │         = 200                 │ │
│  └───────────────────────────────┘ │
│                                     │
│  ┌───────────────────────────────┐ │
│  │ Frequency Score (30% weight)  │ │
│  │                               │ │
│  │ score = (25 / 50) × 1000      │ │
│  │       = 500                   │ │
│  │ weighted = 500 × 0.30         │ │
│  │         = 150                 │ │
│  └───────────────────────────────┘ │
│                                     │
│  ┌───────────────────────────────┐ │
│  │ Diversity Score (20% weight)  │ │
│  │                               │ │
│  │ score = (8 / 10) × 1000       │ │
│  │       = 800                   │ │
│  │ weighted = 800 × 0.20         │ │
│  │         = 160                 │ │
│  └───────────────────────────────┘ │
│                                     │
│  ┌───────────────────────────────┐ │
│  │ Recency Score (10% weight)    │ │
│  │                               │ │
│  │ recent = 3 > 0 ? true : false │ │
│  │ score = true × 1000           │ │
│  │       = 1000                  │ │
│  │ weighted = 1000 × 0.10        │ │
│  │         = 100                 │ │
│  └───────────────────────────────┘ │
└─────────┬───────────────────────────┘
          │
          ↓
┌─────────────────────────────────────┐
│  Sum Component Scores               │
│                                     │
│  Volume:    200                     │
│  Frequency: 150                     │
│  Diversity: 160                     │
│  Recency:   100                     │
│  ─────────────                      │
│  Total:     610                     │
│                                     │
│  ✅ Activity Score = 610            │
└─────────────────────────────────────┘
```

---

## Transaction Separation Logic

```
┌──────────────────────────────────────┐
│  Raw Blockchain Transactions         │
│                                      │
│  1. Hash: 0x123...                   │
│     From: 0xABC... (my wallet)       │
│     To:   0xDEF...                   │
│     Amount: 1.5 STRK                 │
│                                      │
│  2. Hash: 0x456...                   │
│     From: 0xGHI...                   │
│     To:   0xABC... (my wallet)       │
│     Amount: 2.0 STRK                 │
│                                      │
│  3. Hash: 0x789...                   │
│     From: 0xABC... (my wallet)       │
│     To:   0xJKL...                   │
│     Amount: 0.5 STRK                 │
└──────────┬───────────────────────────┘
           │
           │ Separation Logic
           │
           ↓
┌──────────────────────────────────────┐
│  Categorize Each Transaction         │
│                                      │
│  IF tx.from == myWallet:             │
│     → Add to SENT array              │
│                                      │
│  IF tx.to == myWallet:               │
│     → Add to RECEIVED array          │
└──────────┬───────────────────────────┘
           │
           ↓
┌──────────────────────────────────────┐
│  Separated Results                   │
│                                      │
│  📤 SENT (2 transactions)            │
│  ├─ 0x123... → 0xDEF...  1.5 STRK   │
│  └─ 0x789... → 0xJKL...  0.5 STRK   │
│                                      │
│  Total Sent: 2.0 STRK                │
│                                      │
│  📥 RECEIVED (1 transaction)         │
│  └─ 0x456... → 0xABC...  2.0 STRK   │
│                                      │
│  Total Received: 2.0 STRK            │
└──────────────────────────────────────┘
```

---

## API Request/Response Flow

```
User Wallet: 0x22083c8b84ffd614c26468f2ada0c1baad4df98d81a0e1d7d757beb0155dd2d

┌──────────────────────────────────────────────────────────┐
│ REQUEST                                                   │
│                                                           │
│ GET /api/activity/0x22083c8b84ffd614c26468f2ada0c1baad... │
└──────────┬────────────────────────────────────────────────┘
           │
           ↓
┌──────────────────────────────────────────────────────────┐
│ BACKEND PROCESSING                                        │
│                                                           │
│ 1. Validate address format ✅                            │
│ 2. Connect to Blast API RPC                              │
│ 3. Get current block: 123456                             │
│ 4. Scan blocks: 122456 to 123456                         │
│ 5. Find 25 transactions                                  │
│ 6. Separate: 10 sent, 15 received                        │
│ 7. Calculate score: 610                                  │
│ 8. Format response                                       │
└──────────┬────────────────────────────────────────────────┘
           │
           ↓
┌──────────────────────────────────────────────────────────┐
│ RESPONSE                                                  │
│                                                           │
│ {                                                         │
│   "success": true,                                        │
│   "data": {                                               │
│     "score": 610,                                         │
│     "totalTransactions": 25,                              │
│     "totalVolumeFormatted": "12.50 STRK",                │
│     "sentTransactions": {                                 │
│       "count": 10,                                        │
│       "totalAmount": "5000000000000000000",               │
│       "totalAmountFormatted": "5.00 STRK",               │
│       "transactions": [                                   │
│         {                                                 │
│           "txHash": "0x123abc...",                        │
│           "from": "0x22083c8b84...",                      │
│           "to": "0xdef456...",                            │
│           "amount": "1000000000000000000",                │
│           "amountFormatted": "1.00 STRK",                │
│           "blockNumber": 123450,                          │
│           "timestamp": 1705315800                         │
│         }                                                 │
│       ]                                                   │
│     },                                                    │
│     "receivedTransactions": {                             │
│       "count": 15,                                        │
│       "totalAmount": "7500000000000000000",               │
│       "totalAmountFormatted": "7.50 STRK",               │
│       "transactions": [...]                               │
│     },                                                    │
│     "dataSource": "Blast API RPC",                        │
│     "timestamp": "2024-01-15T10:30:00.000Z"              │
│   }                                                       │
│ }                                                         │
└──────────┬────────────────────────────────────────────────┘
           │
           ↓
┌──────────────────────────────────────────────────────────┐
│ FRONTEND RENDERING                                        │
│                                                           │
│ 1. Parse JSON response                                   │
│ 2. Update component state                                │
│ 3. Display activity score: 610                           │
│ 4. Show sent: 10 tx, 5.00 STRK                          │
│ 5. Show received: 15 tx, 7.50 STRK                      │
│ 6. Render transaction list                              │
│ 7. Enable tab filtering                                 │
└──────────────────────────────────────────────────────────┘
```

---

## Component State Management

```
┌─────────────────────────────────────────────────────────┐
│ TransactionHistory Component State                      │
├─────────────────────────────────────────────────────────┤
│                                                          │
│ const [loading, setLoading] = useState(false)           │
│ const [activityData, setActivityData] = useState(null)  │
│ const [error, setError] = useState(null)                │
│ const [activeTab, setActiveTab] = useState('all')       │
│                                                          │
├─────────────────────────────────────────────────────────┤
│                                                          │
│ State Transitions:                                       │
│                                                          │
│ Initial:                                                 │
│   loading = false                                        │
│   activityData = null                                    │
│   error = null                                           │
│   activeTab = 'all'                                      │
│                                                          │
│ During Fetch:                                            │
│   loading = true ✨                                      │
│   activityData = null                                    │
│   error = null                                           │
│   activeTab = 'all'                                      │
│   → Display: Loading indicator                          │
│                                                          │
│ On Success:                                              │
│   loading = false                                        │
│   activityData = { score, sent, received, ... } ✅       │
│   error = null                                           │
│   activeTab = 'all'                                      │
│   → Display: Activity score + transactions              │
│                                                          │
│ On Error:                                                │
│   loading = false                                        │
│   activityData = null                                    │
│   error = "Error message" ❌                            │
│   activeTab = 'all'                                      │
│   → Display: Error message + retry button               │
│                                                          │
│ Tab Change:                                              │
│   loading = false                                        │
│   activityData = { ... }                                 │
│   error = null                                           │
│   activeTab = 'sent' / 'received' / 'all' 🔄            │
│   → Filter: Display only selected transaction type      │
│                                                          │
└─────────────────────────────────────────────────────────┘
```

---

## Error Handling Flow

```
┌─────────────────────────────────────────────────────────┐
│ Request Initiated                                        │
└─────────┬───────────────────────────────────────────────┘
          │
          ↓
┌─────────────────────────────────────────────────────────┐
│ Check 1: Valid Wallet Address                           │
│                                                          │
│ IF address.length !== 66:                               │
│   → Return Error: "Invalid address format"              │
│                                                          │
│ IF !address.startsWith('0x'):                           │
│   → Return Error: "Address must start with 0x"          │
└─────────┬───────────────────────────────────────────────┘
          │ ✅ Valid
          ↓
┌─────────────────────────────────────────────────────────┐
│ Check 2: RPC Connection                                 │
│                                                          │
│ TRY:                                                     │
│   provider = new RpcProvider(...)                       │
│   currentBlock = await provider.getBlockNumber()        │
│                                                          │
│ CATCH:                                                   │
│   → Return Error: "RPC connection failed"               │
└─────────┬───────────────────────────────────────────────┘
          │ ✅ Connected
          ↓
┌─────────────────────────────────────────────────────────┐
│ Check 3: Fetch Transactions                             │
│                                                          │
│ TRY:                                                     │
│   transactions = await fetchTransactions(...)           │
│                                                          │
│ CATCH:                                                   │
│   → Return Error: "Failed to fetch transactions"        │
│                                                          │
│ IF transactions.length === 0:                           │
│   → Return: score = 0, empty arrays                     │
│   → Status: Success (but no transactions)               │
└─────────┬───────────────────────────────────────────────┘
          │ ✅ Transactions found
          ↓
┌─────────────────────────────────────────────────────────┐
│ Check 4: Process Data                                   │
│                                                          │
│ TRY:                                                     │
│   separate sent/received                                │
│   calculate metrics                                     │
│   calculate score                                       │
│   format amounts                                        │
│                                                          │
│ CATCH:                                                   │
│   → Return Error: "Data processing failed"              │
└─────────┬───────────────────────────────────────────────┘
          │ ✅ Success
          ↓
┌─────────────────────────────────────────────────────────┐
│ Return Success Response                                 │
│                                                          │
│ {                                                        │
│   success: true,                                         │
│   data: { score, sentTransactions, receivedTransactions }│
│ }                                                        │
└─────────────────────────────────────────────────────────┘
```

---

## Performance Optimization

```
┌─────────────────────────────────────────────────────────┐
│ Current Implementation (No Cache)                       │
│                                                          │
│ Every Request:                                           │
│ 1. Connect to RPC ⏱️ ~500ms                            │
│ 2. Get block number ⏱️ ~200ms                          │
│ 3. Scan 1000 blocks ⏱️ ~2000ms                         │
│ 4. Process data ⏱️ ~100ms                              │
│ 5. Format response ⏱️ ~50ms                            │
│                                                          │
│ Total: ~2850ms per request                              │
└─────────────────────────────────────────────────────────┘
          │
          ↓
┌─────────────────────────────────────────────────────────┐
│ Proposed Optimization (With Cache)                      │
│                                                          │
│ First Request:                                           │
│ 1. Check cache → MISS                                   │
│ 2. Fetch from RPC ⏱️ ~2850ms                           │
│ 3. Store in cache (TTL: 5 min)                          │
│ 4. Return data                                           │
│                                                          │
│ Subsequent Requests (within 5 min):                     │
│ 1. Check cache → HIT ✅                                 │
│ 2. Return cached data ⏱️ ~10ms                         │
│                                                          │
│ Improvement: 285x faster for cached requests            │
└─────────────────────────────────────────────────────────┘
          │
          ↓
┌─────────────────────────────────────────────────────────┐
│ Cache Implementation (Redis/In-Memory)                  │
│                                                          │
│ const cache = new Map();                                │
│ const CACHE_TTL = 5 * 60 * 1000; // 5 minutes          │
│                                                          │
│ function getCachedActivity(wallet) {                    │
│   const cached = cache.get(wallet);                     │
│   if (cached && Date.now() - cached.time < CACHE_TTL) {│
│     return cached.data;                                 │
│   }                                                      │
│   return null;                                          │
│ }                                                        │
│                                                          │
│ function setCachedActivity(wallet, data) {              │
│   cache.set(wallet, {                                   │
│     data: data,                                         │
│     time: Date.now()                                    │
│   });                                                    │
│ }                                                        │
└─────────────────────────────────────────────────────────┘
```

---

**Last Updated:** January 2024  
**Feature:** Real Transaction-Based Activity Scores  
**Diagrams:** Architecture, Data Flow, Score Calculation, Error Handling, Optimization
