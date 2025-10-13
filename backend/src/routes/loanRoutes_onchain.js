const express = require('express');
const router = express.Router();
const logger = require('../utils/logger');
const { RpcProvider, Contract, CallData, uint256, hash } = require('starknet');

// Contract addresses (update after deployment)
const LOAN_ESCROW_ZK_ADDRESS = process.env.LOAN_ESCROW_ZK_ADDRESS || '0x05a4d3ed7d102ab91715c2b36c70b5e9795a3e917214dbd9af40503d2c29f83d';
const ACTIVITY_VERIFIER_ADDRESS = process.env.ACTIVITY_VERIFIER_ADDRESS || '0x071b94eb84b81868b61fb0ec1bbb59df47bb508583bc79325e5fa997ee3eb4be';
const STRK_TOKEN_ADDRESS = process.env.STRK_TOKEN_ADDRESS || '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d';
const RPC_URL = process.env.STARKNET_RPC || 'https://starknet-sepolia.public.blastapi.io/rpc/v0_7';

const provider = new RpcProvider({ nodeUrl: RPC_URL });

// ABI for LoanEscrowZK contract
const ESCROW_ABI = [
  {
    name: 'get_loan_count',
    type: 'function',
    inputs: [],
    outputs: [{ name: 'count', type: 'u256' }],
    stateMutability: 'view'
  },
  {
    name: 'get_loan_details',
    type: 'function',
    inputs: [{ name: 'loan_id', type: 'u256' }],
    outputs: [{ name: 'loan', type: 'LoanOffer' }],
    stateMutability: 'view'
  },
  {
    name: 'get_application',
    type: 'function',
    inputs: [
      { name: 'loan_id', type: 'u256' },
      { name: 'commitment', type: 'felt252' }
    ],
    outputs: [{ name: 'application', type: 'Application' }],
    stateMutability: 'view'
  }
];

// ABI for ActivityVerifier contract
const VERIFIER_ABI = [
  {
    name: 'register_proof',
    type: 'function',
    inputs: [
      { name: 'proof_hash', type: 'felt252' },
      { name: 'commitment', type: 'felt252' },
      { name: 'activity_score', type: 'u256' }
    ],
    outputs: [],
    stateMutability: 'external'
  },
  {
    name: 'get_proof_score',
    type: 'function',
    inputs: [{ name: 'proof_hash', type: 'felt252' }],
    outputs: [{ name: 'score', type: 'u256' }],
    stateMutability: 'view'
  }
];

/**
 * Register ZK proof on-chain (called by backend after generating proof)
 * This allows the contract to verify it later
 */
router.post('/register-proof', async (req, res) => {
  try {
    const { proofHash, commitment, activityScore } = req.body;

    if (!proofHash || !commitment || !activityScore) {
      return res.status(400).json({
        error: 'Missing required fields: proofHash, commitment, activityScore'
      });
    }

    logger.info('📝 Registering ZK proof on-chain', {
      proofHash,
      commitment: commitment.slice(0, 20) + '...',
      activityScore
    });

    // In production, you'd use a wallet to sign this transaction
    // For now, we return the transaction data for the frontend to execute
    res.json({
      success: true,
      message: 'Proof registration data prepared',
      data: {
        contractAddress: ACTIVITY_VERIFIER_ADDRESS,
        entrypoint: 'register_proof',
        calldata: {
          proof_hash: proofHash,
          commitment,
          activity_score: activityScore
        }
      }
    });
  } catch (error) {
    logger.error('❌ Error registering proof:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Get all loan offers from blockchain events
 */
router.get('/available', async (req, res) => {
  try {
    logger.info('📋 Fetching available loans from blockchain');

    const escrowContract = new Contract(ESCROW_ABI, LOAN_ESCROW_ZK_ADDRESS, provider);
    const loanCountRaw = await escrowContract.get_loan_count();
    
    // Parse loan count from {count: {low, high}} structure
    let loanCount;
    if (loanCountRaw?.count) {
      if (typeof loanCountRaw.count === 'bigint') {
        loanCount = Number(loanCountRaw.count);
      } else if (loanCountRaw.count?.low !== undefined) {
        loanCount = Number(loanCountRaw.count.low);
      }
    }
    
    logger.info(`✅ Total loans on-chain: ${loanCount}`);

    const loans = [];
    
    // Fetch all loans
    for (let i = 1; i <= Number(loanCount); i++) {
      try {
        // Convert to u256 and extract low/high felts
        const { low, high } = uint256.bnToUint256(BigInt(i));
        const rawResult = await provider.callContract({
          contractAddress: LOAN_ESCROW_ZK_ADDRESS,
          entrypoint: 'get_loan_details',
          calldata: [low, high]
        });
        
        // Parse LoanOffer struct
        const loanDetails = {
          lender: rawResult.result[0],
          amount_per_borrower: uint256.uint256ToBN({ low: rawResult.result[1], high: rawResult.result[2] }),
          total_slots: Number(rawResult.result[3]),
          filled_slots: Number(rawResult.result[4]),
          interest_rate_bps: uint256.uint256ToBN({ low: rawResult.result[5], high: rawResult.result[6] }),
          repayment_period: Number(rawResult.result[7]),
          min_activity_score: uint256.uint256ToBN({ low: rawResult.result[8], high: rawResult.result[9] }),
          status: Number(rawResult.result[10]),
          created_at: Number(rawResult.result[11])
        };
        
        // Log loan #36 to debug slots issue
        if (i === 36) {
          logger.info(`🔍 Loan #36 raw data from contract:`, {
            total_slots_raw: rawResult.result[3],
            filled_slots_raw: rawResult.result[4],
            total_slots_parsed: loanDetails.total_slots,
            filled_slots_parsed: loanDetails.filled_slots,
            calculation: `${loanDetails.total_slots} - ${loanDetails.filled_slots} = ${loanDetails.total_slots - loanDetails.filled_slots}`
          });
        }
        
        // Include active loans (status=0) - show even if filled_slots = total_slots
        // Borrowers can still apply (pending), lender decides whether to approve
        if (loanDetails.status === 0) {
          const slotsRemaining = Number(loanDetails.total_slots) - Number(loanDetails.filled_slots);
          
          loans.push({
            id: i.toString(),
            lender: loanDetails.lender,
            amountPerBorrower: loanDetails.amount_per_borrower.toString(),
            totalSlots: Number(loanDetails.total_slots),
            filledSlots: Number(loanDetails.filled_slots),
            slotsRemaining: slotsRemaining,
            interestRate: loanDetails.interest_rate_bps.toString(),
            repaymentPeriod: loanDetails.repayment_period.toString(),
            minActivityScore: loanDetails.min_activity_score.toString(),
            status: 'active',
            createdAt: new Date(Number(loanDetails.created_at) * 1000).toISOString()
          });
          
          // Log loan #36 final data
          if (i === 36) {
            logger.info(`📦 Loan #36 final data being sent to frontend:`, {
              totalSlots: Number(loanDetails.total_slots),
              filledSlots: Number(loanDetails.filled_slots),
              slotsRemaining: slotsRemaining
            });
          }
        }
      } catch (error) {
        logger.error(`Error fetching loan ${i}:`, error.message);
      }
    }

    logger.info(`✅ Found ${loans.length} available loans`);
    res.json(loans);
  } catch (error) {
    logger.error('❌ Error fetching loans:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Get loans created by a specific lender
 */
router.get('/lender/:lenderAddress', async (req, res) => {
  try {
    const { lenderAddress } = req.params;
    logger.info(`� [ONCHAIN-V1] Fetching loans for lender: ${lenderAddress}`);

    const escrowContract = new Contract(ESCROW_ABI, LOAN_ESCROW_ZK_ADDRESS, provider);
    const loanCountRaw = await escrowContract.get_loan_count();
    
    logger.info(`📊 [ONCHAIN-V1] Raw loan count type: ${typeof loanCountRaw}`);
    logger.info(`📊 [ONCHAIN-V1] Object keys: ${Object.keys(loanCountRaw || {}).join(', ')}`);
    
    // Parse loan count - handle different response structures
    let loanCount;
    if (typeof loanCountRaw === 'bigint') {
      loanCount = Number(loanCountRaw);
      logger.info(`📊 [ONCHAIN-V1] Parsed as bigint: ${loanCount}`);
    } else if (typeof loanCountRaw === 'number') {
      loanCount = loanCountRaw;
      logger.info(`📊 [ONCHAIN-V1] Parsed as number: ${loanCount}`);
    } else if (loanCountRaw?.count !== undefined) {
      // Handle {count: <Uint256>} structure - extract count.low or count directly
      const countValue = loanCountRaw.count;
      if (typeof countValue === 'bigint') {
        loanCount = Number(countValue);
      } else if (countValue?.low !== undefined) {
        loanCount = Number(countValue.low);
      } else {
        loanCount = Number(countValue);
      }
      logger.info(`📊 [ONCHAIN-V1] Parsed from .count property: ${loanCount}`);
    } else if (loanCountRaw?.low !== undefined) {
      // Handle direct Uint256 {low, high} structure
      loanCount = Number(loanCountRaw.low);
      logger.info(`📊 [ONCHAIN-V1] Parsed from .low property: ${loanCount}`);
    } else {
      logger.warn(`⚠️ [ONCHAIN-V1] Unknown loan count structure, defaulting to 0`);
      loanCount = 0;
    }
    
    logger.info(`📊 [ONCHAIN-V1] Final parsed loan count: ${loanCount}`);
    
    const loans = [];
    
    for (let i = 1; i <= loanCount; i++) {
      try {
        logger.info(`🔍 [ONCHAIN-V1] Fetching loan ${i}...`);
        
        // Convert to u256 and extract low/high felts
        const { low, high } = uint256.bnToUint256(BigInt(i));
        const rawResult = await provider.callContract({
          contractAddress: LOAN_ESCROW_ZK_ADDRESS,
          entrypoint: 'get_loan_details',
          calldata: [low, high]
        });
        
        // Parse LoanOffer struct from raw result
        // [lender, amount_low, amount_high, total_slots, filled_slots, 
        //  interest_low, interest_high, repayment_period, min_score_low, min_score_high, status, created_at]
        const loanDetails = {
          lender: rawResult.result[0],
          amount_per_borrower: uint256.uint256ToBN({ low: rawResult.result[1], high: rawResult.result[2] }),
          total_slots: Number(rawResult.result[3]),
          filled_slots: Number(rawResult.result[4]),
          interest_rate_bps: uint256.uint256ToBN({ low: rawResult.result[5], high: rawResult.result[6] }),
          repayment_period: Number(rawResult.result[7]),
          min_activity_score: uint256.uint256ToBN({ low: rawResult.result[8], high: rawResult.result[9] }),
          status: Number(rawResult.result[10]),
          created_at: Number(rawResult.result[11])
        };
        
        logger.info(`📦 [ONCHAIN-V1] Loan ${i} details received, lender: ${loanDetails.lender}`);
        
        // Filter by lender address
        if (loanDetails.lender.toLowerCase() === lenderAddress.toLowerCase()) {
          loans.push({
            id: i.toString(),
            lender: loanDetails.lender,
            amountPerBorrower: loanDetails.amount_per_borrower.toString(),
            totalSlots: Number(loanDetails.total_slots),
            filledSlots: Number(loanDetails.filled_slots),
            slotsRemaining: Number(loanDetails.total_slots) - Number(loanDetails.filled_slots),
            interestRate: loanDetails.interest_rate_bps.toString(),
            repaymentPeriod: loanDetails.repayment_period.toString(),
            minActivityScore: loanDetails.min_activity_score.toString(),
            status: loanDetails.status === 0 ? 'active' : loanDetails.status === 1 ? 'funded' : 'cancelled',
            createdAt: new Date(Number(loanDetails.created_at) * 1000).toISOString()
          });
          logger.info(`✅ [ONCHAIN-V1] Added loan ${i} to results`);
        } else {
          logger.info(`⏭️ [ONCHAIN-V1] Skipping loan ${i} (different lender: ${loanDetails.lender})`);
        }
      } catch (error) {
        logger.error(`❌ [ONCHAIN-V1] Error fetching loan ${i}:`, {
          message: error.message,
          stack: error.stack,
          name: error.name
        });
      }
    }

    logger.info(`✅ Found ${loans.length} loans for lender`);
    res.json({ loans });
  } catch (error) {
    logger.error('❌ Error fetching lender loans:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Get application details for a specific loan and commitment
 */
router.get('/application/:loanId/:commitment', async (req, res) => {
  try {
    const { loanId, commitment } = req.params;
    
    logger.info('📬 Fetching application', { loanId, commitment: commitment.slice(0, 20) + '...' });

    const escrowContract = new Contract(ESCROW_ABI, LOAN_ESCROW_ZK_ADDRESS, provider);
    const application = await escrowContract.get_application(loanId, commitment);

    if (application.borrower === '0x0' || !application.borrower) {
      return res.status(404).json({ error: 'Application not found' });
    }

    const result = {
      loanId,
      borrower: application.borrower,
      commitment: application.commitment,
      proofHash: application.proof_hash,
      status: application.status === 0 ? 'pending' : application.status === 1 ? 'approved' : 'repaid',
      appliedAt: new Date(Number(application.applied_at) * 1000).toISOString(),
      approvedAt: application.approved_at > 0 ? new Date(Number(application.approved_at) * 1000).toISOString() : null,
      repaidAt: application.repaid_at > 0 ? new Date(Number(application.repaid_at) * 1000).toISOString() : null,
      repaymentDeadline: application.repayment_deadline > 0 ? new Date(Number(application.repayment_deadline) * 1000).toISOString() : null
    };

    logger.info('✅ Application found:', result.status);
    res.json(result);
  } catch (error) {
    logger.error('❌ Error fetching application:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Get all applications for a specific loan
 * This queries LoanApplicationSubmitted events from blockchain
 */
router.get('/:loanId/applications', async (req, res) => {
  try {
    const { loanId } = req.params;
    
    logger.info('📬 Fetching applications for loan:', loanId);

    const escrowContract = new Contract(ESCROW_ABI, LOAN_ESCROW_ZK_ADDRESS, provider);
    
    // Get loan details first to verify loan exists
    const { low: loanLow, high: loanHigh } = uint256.bnToUint256(BigInt(loanId));
    
    const loanRawResult = await provider.callContract({
      contractAddress: LOAN_ESCROW_ZK_ADDRESS,
      entrypoint: 'get_loan_details',
      calldata: [loanLow, loanHigh]
    });
    
    const loanDetails = {
      lender: loanRawResult.result[0],
      amount_per_borrower: uint256.uint256ToBN({ low: loanRawResult.result[1], high: loanRawResult.result[2] }),
      interest_rate_bps: uint256.uint256ToBN({ low: loanRawResult.result[5], high: loanRawResult.result[6] }),
      min_activity_score: uint256.uint256ToBN({ low: loanRawResult.result[8], high: loanRawResult.result[9] })
    };
    
    logger.info('✅ Loan found', { loanId, lender: loanDetails.lender });
    
    // Query LoanApplicationSubmitted events for this loan_id
    const applications = [];
    
    try {
      logger.info('🔍 Querying LoanApplicationSubmitted events...');
      
      // Get event selector for LoanApplicationSubmitted
      const eventKey = hash.getSelectorFromName('LoanApplicationSubmitted');
      logger.info('Event selector:', eventKey);
      
      const eventFilter = {
        from_block: { block_number: 0 }, // Query from genesis
        to_block: 'latest',
        address: LOAN_ESCROW_ZK_ADDRESS,
        keys: [[eventKey]],
        chunk_size: 1000
      };

      logger.info('🔍 Querying with filter:', { 
        address: LOAN_ESCROW_ZK_ADDRESS,
        eventKey,
        from_block: 0 
      });

      const eventsResult = await provider.getEvents(eventFilter);
      logger.info(`📊 Total events found: ${eventsResult.events?.length || 0}`);

      if (eventsResult.events && eventsResult.events.length > 0) {
        logger.info('📋 Sample event structure:', JSON.stringify(eventsResult.events[0], null, 2));
      }

      // Filter events for this specific loan_id and fetch application details
      for (const event of (eventsResult.events || [])) {
        try {
          // Parse event data
          // Event structure: LoanApplicationSubmitted(loan_id: u256, borrower: ContractAddress, commitment: felt252)
          const eventLoanIdLow = event.data[0];
          const eventLoanIdHigh = event.data[1];
          const eventLoanId = uint256.uint256ToBN({ low: eventLoanIdLow, high: eventLoanIdHigh }).toString();
          
          if (eventLoanId === loanId.toString()) {
            const borrowerAddress = event.data[2];
            const commitment = event.data[3];
            
            logger.info(`✅ Found application for loan ${loanId}!`, { 
              borrower: borrowerAddress,
              commitment: commitment.slice(0, 20) + '...'
            });

            // Fetch full application details from contract
            try {
              const appRawResult = await provider.callContract({
                contractAddress: LOAN_ESCROW_ZK_ADDRESS,
                entrypoint: 'get_application',
                calldata: [loanLow, loanHigh, commitment]
              });

              const appDetails = {
                borrower: appRawResult.result[0],
                commitment: appRawResult.result[1],
                proof_hash: appRawResult.result[2],
                status: Number(appRawResult.result[3]),
                applied_at: Number(appRawResult.result[4]),
                approved_at: Number(appRawResult.result[5]),
                repaid_at: Number(appRawResult.result[6]),
                repayment_deadline: Number(appRawResult.result[7])
              };

              // Get activity score from verifier contract
              let activityScore = 0;
              try {
                const scoreResult = await provider.callContract({
                  contractAddress: ACTIVITY_VERIFIER_ADDRESS,
                  entrypoint: 'get_proof_score',
                  calldata: [appDetails.proof_hash]
                });
                activityScore = uint256.uint256ToBN({ 
                  low: scoreResult.result[0], 
                  high: scoreResult.result[1] 
                }).toString();
              } catch (scoreError) {
                logger.warn('Could not fetch activity score:', scoreError.message);
              }

              applications.push({
                loanId,
                borrower: appDetails.borrower,
                commitment: appDetails.commitment,
                proofHash: appDetails.proof_hash,
                activityScore,
                status: appDetails.status === 0 ? 'pending' : appDetails.status === 1 ? 'approved' : 'repaid',
                appliedAt: new Date(appDetails.applied_at * 1000).toISOString(),
                approvedAt: appDetails.approved_at > 0 ? new Date(appDetails.approved_at * 1000).toISOString() : null,
                repaidAt: appDetails.repaid_at > 0 ? new Date(appDetails.repaid_at * 1000).toISOString() : null,
                repaymentDeadline: appDetails.repayment_deadline > 0 ? new Date(appDetails.repayment_deadline * 1000).toISOString() : null
              });
            } catch (appError) {
              logger.error(`Failed to fetch application details for commitment ${commitment}:`, appError.message);
            }
          }
        } catch (parseError) {
          logger.error('Failed to parse event:', parseError.message);
        }
      }
      
      logger.info(`✅ Found ${applications.length} applications for loan ${loanId}`);
    } catch (eventError) {
      logger.error('❌ Event querying failed:', eventError.message);
      logger.info('⚠️ Returning loan details without applications due to event query failure');
    }
    
    res.json({
      success: true,
      loanId,
      loanDetails: {
        lender: loanDetails.lender,
        amount: loanDetails.amount_per_borrower.toString(),
        interestRate: loanDetails.interest_rate_bps.toString(),
        minActivityScore: loanDetails.min_activity_score.toString()
      },
      applications,
      message: applications.length === 0 
        ? 'No applications found for this loan' 
        : `Found ${applications.length} application(s)`
    });
  } catch (error) {
    logger.error('❌ Error fetching loan applications:', { 
      error: error.message, 
      stack: error.stack,
      loanId: req.params.loanId 
    });
    res.status(500).json({ error: error.message || 'Failed to fetch applications' });
  }
});

/**
 * Get all applications for a borrower (by commitment)
 * Note: This requires scanning all loans - not efficient
 * In production, use event indexing service
 */
router.get('/borrower/:commitment/applications', async (req, res) => {
  try {
    const { commitment } = req.params;
    
    logger.info('📬 Fetching applications for borrower commitment:', commitment.slice(0, 30) + '...');
    logger.info('📬 Commitment length:', commitment.length, 'Full:', commitment);

    // Handle both truncated (63 hex chars) and full (64 hex chars) commitments
    // for backwards compatibility with old applications
    const commitments = [commitment];
    if (commitment.length === 66) { // 0x + 64 hex chars
      const truncated = '0x' + commitment.slice(2, 65); // Keep first 63 hex chars
      commitments.push(truncated);
      logger.info('📬 Also checking truncated commitment:', truncated);
    }

    const escrowContract = new Contract(ESCROW_ABI, LOAN_ESCROW_ZK_ADDRESS, provider);
    const loanCountRaw = await escrowContract.get_loan_count();
    
    // Parse loan count
    let loanCount;
    if (loanCountRaw?.count) {
      if (typeof loanCountRaw.count === 'bigint') {
        loanCount = Number(loanCountRaw.count);
      } else if (loanCountRaw.count?.low !== undefined) {
        loanCount = Number(loanCountRaw.count.low);
      }
    }
    
    const applications = [];
    
    // Scan all loans for applications with ANY of the commitment variants
    logger.info(`🔍 Scanning ${loanCount} loans for applications with ${commitments.length} commitment variants...`);
    for (let i = 1; i <= Number(loanCount); i++) {
      // Try each commitment variant (full and truncated)
      for (const commitmentVariant of commitments) {
        try {
          // Use callContract for u256 parameter
          const { low: loanLow, high: loanHigh } = uint256.bnToUint256(BigInt(i));
          const appRawResult = await provider.callContract({
            contractAddress: LOAN_ESCROW_ZK_ADDRESS,
            entrypoint: 'get_application',
            calldata: [loanLow, loanHigh, commitmentVariant]
          });
          
          // Parse Application struct
          // [borrower, commitment, proof_hash, status, applied_at, approved_at, repayment_deadline]
          const application = {
            borrower: appRawResult.result[0],
            commitment: appRawResult.result[1],
            proof_hash: appRawResult.result[2],
            status: Number(appRawResult.result[3]),
            applied_at: Number(appRawResult.result[4]),
            approved_at: Number(appRawResult.result[5]),
            repayment_deadline: Number(appRawResult.result[6])
          };
          
          // Log for loan 3 (the one you applied to) to see what the contract returns
          if (i === 3) {
            logger.info(`🔍 Loan #3 application data (variant: ${commitmentVariant.slice(0, 20)}...):`, {
              borrower: application.borrower,
              commitment_from_contract: application.commitment,
              commitment_queried: commitmentVariant,
              match: application.commitment === commitmentVariant,
              borrower_is_zero: application.borrower === '0x0'
            });
          }
          
          if (application.borrower !== '0x0' && application.borrower) {
            logger.info(`✅ Found application for loan ${i} with commitment variant ${commitmentVariant.slice(0, 20)}...!`, {
              borrower: application.borrower,
              commitment: application.commitment,
              status: application.status
            });
          const loanRawResult = await provider.callContract({
            contractAddress: LOAN_ESCROW_ZK_ADDRESS,
            entrypoint: 'get_loan_details',
            calldata: [loanLow, loanHigh]
          });
          
          const loanDetails = {
            lender: loanRawResult.result[0],
            amount_per_borrower: uint256.uint256ToBN({ low: loanRawResult.result[1], high: loanRawResult.result[2] }),
            interest_rate_bps: uint256.uint256ToBN({ low: loanRawResult.result[5], high: loanRawResult.result[6] })
          };
          
          applications.push({
            loanId: i.toString(),
            lender: loanDetails.lender,
            amount: loanDetails.amount_per_borrower.toString(),
            interestRate: loanDetails.interest_rate_bps.toString(),
            borrower: application.borrower,
            commitment: application.commitment,
            proofHash: application.proof_hash,
            status: application.status === 0 ? 'pending' : application.status === 1 ? 'approved' : 'repaid',
            appliedAt: new Date(Number(application.applied_at) * 1000).toISOString(),
            approvedAt: application.approved_at > 0 ? new Date(Number(application.approved_at) * 1000).toISOString() : null,
            repaymentDeadline: application.repayment_deadline > 0 ? new Date(Number(application.repayment_deadline) * 1000).toISOString() : null
          });
          break; // Found application with this commitment variant, don't try other variants
        }
        } catch (error) {
          // Application doesn't exist for this loan+commitment combination, try next variant
        }
      } // End commitmentVariant loop
    } // End loan loop

    logger.info(`✅ Found ${applications.length} applications`);
    res.json(applications);
  } catch (error) {
    logger.error('❌ Error fetching applications:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Get applications for a borrower (all statuses: pending, approved, repaid)
 * DUPLICATE ROUTE - Should be removed, keeping first one above
 */
router.get('/borrower/:commitment/applications_OLD', async (req, res) => {
  try {
    const { commitment } = req.params;
    
    logger.info('📬 Fetching applications for borrower commitment:', commitment.slice(0, 20) + '...');
    logger.info('📬 Commitment length:', commitment.length, 'Type:', typeof commitment);

    const escrowContract = new Contract(ESCROW_ABI, LOAN_ESCROW_ZK_ADDRESS, provider);
    const loanCountRaw = await escrowContract.get_loan_count();
    
    // Parse loan count
    let loanCount;
    if (loanCountRaw?.count) {
      if (typeof loanCountRaw.count === 'bigint') {
        loanCount = Number(loanCountRaw.count);
      } else if (loanCountRaw.count?.low !== undefined) {
        loanCount = Number(loanCountRaw.count.low);
      }
    }
    
    logger.info(`🔍 Scanning ${loanCount} loans for applications with commitment ${commitment.slice(0, 20)}...`);

    const applications = [];
    
    // Scan all loans to find applications with this commitment
    for (let i = 1; i <= Number(loanCount); i++) {
      try {
        const { low: loanLow, high: loanHigh } = uint256.bnToUint256(BigInt(i));
        const appRawResult = await provider.callContract({
          contractAddress: LOAN_ESCROW_ZK_ADDRESS,
          entrypoint: 'get_application',
          calldata: [loanLow, loanHigh, commitment]
        });
        
        const application = {
          borrower: appRawResult.result[0],
          commitment: appRawResult.result[1],
          proof_hash: appRawResult.result[2],
          status: Number(appRawResult.result[3]),
          applied_at: Number(appRawResult.result[4]),
          approved_at: Number(appRawResult.result[5]),
          repaid_at: Number(appRawResult.result[6]),
          repayment_deadline: Number(appRawResult.result[7])
        };
        
        // Include if application exists (borrower is not 0x0)
        if (application.borrower !== '0x0') {
          // Get loan details
          const loanRawResult = await provider.callContract({
            contractAddress: LOAN_ESCROW_ZK_ADDRESS,
            entrypoint: 'get_loan_details',
            calldata: [loanLow, loanHigh]
          });
          
          const loanDetails = {
            lender: loanRawResult.result[0],
            amount_per_borrower: uint256.uint256ToBN({ low: loanRawResult.result[1], high: loanRawResult.result[2] }),
            interest_rate_bps: uint256.uint256ToBN({ low: loanRawResult.result[5], high: loanRawResult.result[6] })
          };
          
          applications.push({
            loanId: i.toString(),
            lender: loanDetails.lender,
            amount: loanDetails.amount_per_borrower.toString(),
            interestRate: loanDetails.interest_rate_bps.toString(),
            borrower: application.borrower,
            commitment: application.commitment,
            proofHash: application.proof_hash,
            status: application.status === 0 ? 'pending' : application.status === 1 ? 'approved' : 'repaid',
            appliedAt: new Date(Number(application.applied_at) * 1000).toISOString(),
            approvedAt: application.approved_at > 0 ? new Date(Number(application.approved_at) * 1000).toISOString() : null,
            repaidAt: application.repaid_at > 0 ? new Date(Number(application.repaid_at) * 1000).toISOString() : null,
            repaymentDeadline: application.repayment_deadline > 0 ? new Date(Number(application.repayment_deadline) * 1000).toISOString() : null
          });
        }
      } catch (error) {
        // Application doesn't exist for this loan, continue
      }
    }

    logger.info(`✅ Found ${applications.length} applications`);
    res.json(applications);
  } catch (error) {
    logger.error('❌ Error fetching applications:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Get active loans for a borrower (approved but not repaid)
 */
router.get('/borrower/:commitment/active', async (req, res) => {
  try {
    const { commitment } = req.params;
    
    logger.info('💼 Fetching active loans for borrower commitment:', commitment.slice(0, 20) + '...');

    const escrowContract = new Contract(ESCROW_ABI, LOAN_ESCROW_ZK_ADDRESS, provider);
    const loanCountRaw = await escrowContract.get_loan_count();
    
    // Parse loan count
    let loanCount;
    if (loanCountRaw?.count) {
      if (typeof loanCountRaw.count === 'bigint') {
        loanCount = Number(loanCountRaw.count);
      } else if (loanCountRaw.count?.low !== undefined) {
        loanCount = Number(loanCountRaw.count.low);
      }
    }
    
    const activeLoans = [];
    
    for (let i = 1; i <= Number(loanCount); i++) {
      try {
        // Use callContract for u256 parameter
        const { low: loanLow, high: loanHigh } = uint256.bnToUint256(BigInt(i));
        const appRawResult = await provider.callContract({
          contractAddress: LOAN_ESCROW_ZK_ADDRESS,
          entrypoint: 'get_application',
          calldata: [loanLow, loanHigh, commitment]
        });
        
        // Parse Application struct
        const application = {
          borrower: appRawResult.result[0],
          status: Number(appRawResult.result[3]),
          applied_at: Number(appRawResult.result[4]),
          approved_at: Number(appRawResult.result[5]),
          repayment_deadline: Number(appRawResult.result[6]),
          commitment: appRawResult.result[1]
        };
        
        // Only include approved loans (status = 1)
        if (application.borrower !== '0x0' && application.status === 1) {
          const loanRawResult = await provider.callContract({
            contractAddress: LOAN_ESCROW_ZK_ADDRESS,
            entrypoint: 'get_loan_details',
            calldata: [loanLow, loanHigh]
          });
          
          const loanDetails = {
            lender: loanRawResult.result[0],
            amount_per_borrower: uint256.uint256ToBN({ low: loanRawResult.result[1], high: loanRawResult.result[2] }),
            interest_rate_bps: uint256.uint256ToBN({ low: loanRawResult.result[5], high: loanRawResult.result[6] })
          };
          
          activeLoans.push({
            loanId: i.toString(),
            lender: loanDetails.lender,
            amount: loanDetails.amount_per_borrower.toString(),
            interestRate: loanDetails.interest_rate_bps.toString(),
            borrower: application.borrower,
            commitment: application.commitment,
            status: 'approved',
            approvedAt: new Date(Number(application.approved_at) * 1000).toISOString(),
            repaymentDeadline: new Date(Number(application.repayment_deadline) * 1000).toISOString()
          });
        }
      } catch (error) {
        // Continue
      }
    }

    logger.info(`✅ Found ${activeLoans.length} active loans`);
    res.json(activeLoans);
  } catch (error) {
    logger.error('❌ Error fetching active loans:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Get proof verification status
 */
router.get('/proof/:proofHash/verify', async (req, res) => {
  try {
    const { proofHash } = req.params;
    
    logger.info('🔍 Checking proof verification:', proofHash.slice(0, 20) + '...');

    const verifierContract = new Contract(VERIFIER_ABI, ACTIVITY_VERIFIER_ADDRESS, provider);
    const score = await verifierContract.get_proof_score(proofHash);

    res.json({
      proofHash,
      verified: score > 0,
      activityScore: score.toString()
    });
  } catch (error) {
    logger.error('❌ Error checking proof:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
