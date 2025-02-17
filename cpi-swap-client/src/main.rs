mod helpers;
mod retryable_rpc;

use base64::engine::Engine;
use borsh::{BorshDeserialize, BorshSerialize};
use helpers::{get_address_lookup_table_accounts, get_discriminator};
use jup_swap::{
    quote::QuoteRequest,
    swap::SwapRequest,
    transaction_config::{DynamicSlippageSettings, TransactionConfig},
    JupiterSwapApiClient,
};
use solana_client::{rpc_client::RpcClient, rpc_config::RpcSimulateTransactionConfig};
use solana_sdk::{
    commitment_config::CommitmentConfig,
    compute_budget::ComputeBudgetInstruction,
    instruction::{AccountMeta, Instruction},
    message::{v0::Message, VersionedMessage},
    pubkey,
    pubkey::Pubkey,
    signature::Keypair,
    signer::Signer,
    transaction::VersionedTransaction,
};
use spl_associated_token_account::{
    get_associated_token_address, instruction::create_associated_token_account_idempotent,
};
use spl_token::ID as TOKEN_PROGRAM_ID;
use std::env;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio;
use tokio::sync::RwLock;

// USD EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
// SOL So11111111111111111111111111111111111111112

const INPUT_MINT: Pubkey = pubkey!("So11111111111111111111111111111111111111112");
const INPUT_AMOUNT: u64 = 20;
const OUTPUT_MINT: Pubkey = pubkey!("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");

const CPI_SWAP_PROGRAM_ID: Pubkey = pubkey!("8KQG1MYXru73rqobftpFjD3hBD8Ab3jaag8wbjZG63sx");
const JUPITER_PROGRAM_ID: Pubkey = pubkey!("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");
const DEFAULT_RPC_URL: &str = "https://api.mainnet-beta.solana.com";

struct LatestBlockhash {
    blockhash: RwLock<solana_sdk::hash::Hash>,
    slot: AtomicU64,
}

#[derive(BorshSerialize, BorshDeserialize)]
pub struct SwapIxData {
    pub data: Vec<u8>,
}

#[tokio::main]
async fn main() {
    let rpc_url = DEFAULT_RPC_URL.to_string();

    let keypair_str = "[152,88,152,250,220,149,198,252,107,48,197,42,115,172,246,149,42,193,252,79,103,137,40,140,9,160,233,137,127,159,34,158,55,116,254,213,22,206,79,12,64,21,244,25,61,56,175,11,177,61,12,84,191,245,22,151,52,155,156,166,109,122,166,89]";
    let keypair_bytes: Vec<u8> = keypair_str
        .trim_start_matches('[')
        .trim_end_matches(']')
        .split(',')
        .map(|s| s.trim().parse().expect("Failed to parse u8 value"))
        .collect();
    let keypair = Keypair::from_bytes(&keypair_bytes).unwrap();
    let keypair_pubkey = keypair.pubkey();

    let rpc_client = Arc::new(RpcClient::new_with_commitment(
        rpc_url.to_string(),
        CommitmentConfig::confirmed(),
    ));

    let rpc_client_clone = rpc_client.clone();
    let latest_blockhash = Arc::new(LatestBlockhash {
        blockhash: RwLock::new(solana_sdk::hash::Hash::default()),
        slot: AtomicU64::new(0),
    });

    let latest_blockhash_clone = latest_blockhash.clone();
    tokio::spawn(async move {
        loop {
            if let Ok((blockhash, slot)) =
                rpc_client_clone.get_latest_blockhash_with_commitment(CommitmentConfig::confirmed())
            {
                let mut blockhash_write = latest_blockhash_clone.blockhash.write().await;
                *blockhash_write = blockhash;
                latest_blockhash_clone.slot.store(slot, Ordering::Relaxed);
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
    });

    let api_base_url = env::var("API_BASE_URL").unwrap_or("https://quote-api.jup.ag/v6".into());

    let jupiter_swap_api_client = JupiterSwapApiClient::new(api_base_url);

    let quote_request = QuoteRequest {
        amount: INPUT_AMOUNT,
        input_mint: INPUT_MINT,
        output_mint: OUTPUT_MINT,
        ..QuoteRequest::default()
    };

    // GET /quote
    let quote_response = match jupiter_swap_api_client.quote(&quote_request).await {
        Ok(quote_response) => {
            let cloned_reponse = quote_response.clone();
            let quote_out_amount = cloned_reponse.out_amount;
            println!("Out amount {}", quote_out_amount.to_string());

            quote_response.clone()
        }
        Err(e) => {
            println!("quote failed: {e:#?}");
            return;
        }
    };

    let (vault, _) = Pubkey::find_program_address(&[b"vault"], &CPI_SWAP_PROGRAM_ID);

    let response = jupiter_swap_api_client
        .swap_instructions(&SwapRequest {
            user_public_key: vault,
            quote_response,
            config: TransactionConfig {
                skip_user_accounts_rpc_calls: true,
                wrap_and_unwrap_sol: false,
                dynamic_compute_unit_limit: true,
                dynamic_slippage: Some(DynamicSlippageSettings {
                    min_bps: Some(50),
                    max_bps: Some(1000),
                }),
                ..TransactionConfig::default()
            },
        })
        .await
        .unwrap();

    let address_lookup_table_accounts =
        get_address_lookup_table_accounts(&rpc_client, response.address_lookup_table_addresses)
            .await
            .unwrap();

    println!("Vault: {}", vault);
    let input_token_account = get_associated_token_address(&vault, &INPUT_MINT);
    println!("input_token_account: {}", input_token_account.to_string());
    let output_token_account = get_associated_token_address(&vault, &OUTPUT_MINT);
    println!("output_token_account: {}", output_token_account.to_string());

    let create_output_ata_ix = create_associated_token_account_idempotent(
        &keypair.pubkey(),
        &vault,
        &OUTPUT_MINT,
        &TOKEN_PROGRAM_ID,
    );

    let instruction_data = SwapIxData {
        data: response.swap_instruction.data,
    };

    let mut serialized_data = Vec::from(get_discriminator("global:swap"));
    let mut serialized_dataa = Vec::from([]);
    instruction_data.serialize(&mut serialized_dataa).unwrap();
    instruction_data.serialize(&mut serialized_data).unwrap();

    let mut accounts = vec![
        AccountMeta::new_readonly(INPUT_MINT, false), // input mint
        AccountMeta::new_readonly(TOKEN_PROGRAM_ID, false), // input mint program (for now, just hardcoded to SPL and not SPL 2022)
        AccountMeta::new_readonly(OUTPUT_MINT, false),      // output mint
        AccountMeta::new_readonly(TOKEN_PROGRAM_ID, false), // output mint program (for now, just hardcoded to SPL and not SPL 2022)
        AccountMeta::new(vault, false),                     // vault
        AccountMeta::new(input_token_account, false),       // vault input token account
        AccountMeta::new(output_token_account, false),      // vault output token account
        AccountMeta::new_readonly(JUPITER_PROGRAM_ID, false), // jupiter program
    ];
    let remaining_accounts = response.swap_instruction.accounts;
    accounts.extend(remaining_accounts.into_iter().map(|mut account| {
        println!("{}", account.pubkey);
        account.is_signer = false;
        account
    }));

    let swap_ix = Instruction {
        program_id: CPI_SWAP_PROGRAM_ID,
        accounts,
        data: serialized_data,
    };

    let simulate_cu_ix = ComputeBudgetInstruction::set_compute_unit_limit(1_400_000);
    let cup_ix = ComputeBudgetInstruction::set_compute_unit_price(200_000);
    loop {
        let slot = latest_blockhash.slot.load(Ordering::Relaxed);
        if slot != 0 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let recent_blockhash = latest_blockhash.blockhash.read().await;

    let simulate_message = Message::try_compile(
        &keypair_pubkey,
        &[
            simulate_cu_ix,
            cup_ix.clone(),
            create_output_ata_ix.clone(),
            swap_ix.clone(),
        ],
        &address_lookup_table_accounts,
        *recent_blockhash,
    )
    .unwrap();
    let simulate_tx =
        VersionedTransaction::try_new(VersionedMessage::V0(simulate_message), &[&keypair]).unwrap();
    let simulated_cu = match rpc_client.simulate_transaction_with_config(
        &simulate_tx,
        RpcSimulateTransactionConfig {
            replace_recent_blockhash: true,
            ..RpcSimulateTransactionConfig::default()
        },
    ) {
        Ok(simulate_result) => {
            if simulate_result.value.err.is_some() {
                let e: solana_sdk::transaction::TransactionError =
                    simulate_result.value.err.unwrap();
                panic!(
                    "Failed to simulate transaction due to {:?} logs:{:?}",
                    e, simulate_result.value.logs
                );
            }
            simulate_result.value.units_consumed.unwrap()
        }
        Err(e) => {
            panic!("simulate failed: {e:#?}");
        }
    };

    let cu_ix = ComputeBudgetInstruction::set_compute_unit_limit((simulated_cu + 10_000) as u32);

    let recent_blockhash = latest_blockhash.blockhash.read().await;
    println!("Latest blockhash: {}", recent_blockhash);
    let message = Message::try_compile(
        &keypair_pubkey,
        &[cu_ix, cup_ix, create_output_ata_ix, swap_ix],
        &address_lookup_table_accounts,
        *recent_blockhash,
    )
    .unwrap();

    println!(
        "Base64 EncodedTransaction message: {}",
        base64::engine::general_purpose::STANDARD
            .encode(VersionedMessage::V0(message.clone()).serialize())
    );
    let tx: VersionedTransaction =
        VersionedTransaction::try_new(VersionedMessage::V0(message), &[&keypair]).unwrap();
    let retryable_client = retryable_rpc::RetryableRpcClient::new(&rpc_url);

    let tx_hash = tx.signatures[0];

    if let Ok(tx_hash) = retryable_client.send_and_confirm_transaction(&tx).await {
        println!(
            "Transaction confirmed: https://explorer.solana.com/tx/{}",
            tx_hash
        );
    } else {
        println!(
            "Transaction failed: https://explorer.solana.com/tx/{}",
            tx_hash
        );
        return;
    };
}
