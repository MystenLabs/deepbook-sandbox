use anyhow::Context;
use clap::Parser;
use deepbook_indexer::handlers::balances_handler::BalancesHandler;
use deepbook_indexer::handlers::deep_burned_handler::DeepBurnedHandler;
use deepbook_indexer::handlers::flash_loan_handler::FlashLoanHandler;
use deepbook_indexer::handlers::order_fill_handler::OrderFillHandler;
use deepbook_indexer::handlers::order_update_handler::OrderUpdateHandler;
use deepbook_indexer::handlers::pool_price_handler::PoolPriceHandler;
use deepbook_indexer::handlers::proposals_handler::ProposalsHandler;
use deepbook_indexer::handlers::rebates_handler::RebatesHandler;
use deepbook_indexer::handlers::referral_fee_event_handler::ReferralFeeEventHandler;
use deepbook_indexer::handlers::stakes_handler::StakesHandler;
use deepbook_indexer::handlers::trade_params_update_handler::TradeParamsUpdateHandler;
use deepbook_indexer::handlers::vote_handler::VotesHandler;

// Margin Manager Events
use deepbook_indexer::handlers::liquidation_handler::LiquidationHandler;
use deepbook_indexer::handlers::loan_borrowed_handler::LoanBorrowedHandler;
use deepbook_indexer::handlers::loan_repaid_handler::LoanRepaidHandler;
use deepbook_indexer::handlers::margin_manager_created_handler::MarginManagerCreatedHandler;

// Margin Pool Operations Events
use deepbook_indexer::handlers::asset_supplied_handler::AssetSuppliedHandler;
use deepbook_indexer::handlers::asset_withdrawn_handler::AssetWithdrawnHandler;
use deepbook_indexer::handlers::maintainer_fees_withdrawn_handler::MaintainerFeesWithdrawnHandler;
use deepbook_indexer::handlers::protocol_fees_withdrawn_handler::ProtocolFeesWithdrawnHandler;
use deepbook_indexer::handlers::supplier_cap_minted_handler::SupplierCapMintedHandler;
use deepbook_indexer::handlers::supply_referral_minted_handler::SupplyReferralMintedHandler;

// Margin Pool Admin Events
use deepbook_indexer::handlers::deepbook_pool_updated_handler::DeepbookPoolUpdatedHandler;
use deepbook_indexer::handlers::interest_params_updated_handler::InterestParamsUpdatedHandler;
use deepbook_indexer::handlers::margin_pool_config_updated_handler::MarginPoolConfigUpdatedHandler;
use deepbook_indexer::handlers::margin_pool_created_handler::MarginPoolCreatedHandler;

// Margin Registry Events
use deepbook_indexer::handlers::deepbook_pool_config_updated_handler::DeepbookPoolConfigUpdatedHandler;
use deepbook_indexer::handlers::deepbook_pool_registered_handler::DeepbookPoolRegisteredHandler;
use deepbook_indexer::handlers::deepbook_pool_updated_registry_handler::DeepbookPoolUpdatedRegistryHandler;
use deepbook_indexer::handlers::maintainer_cap_updated_handler::MaintainerCapUpdatedHandler;
use deepbook_indexer::handlers::pause_cap_updated_handler::PauseCapUpdatedHandler;

// Protocol Fees Events
use deepbook_indexer::handlers::protocol_fees_increased_handler::ProtocolFeesIncreasedHandler;
use deepbook_indexer::handlers::referral_fees_claimed_handler::ReferralFeesClaimedHandler;

// Collateral Events
use deepbook_indexer::handlers::deposit_collateral_handler::DepositCollateralHandler;
use deepbook_indexer::handlers::withdraw_collateral_handler::WithdrawCollateralHandler;

// TPSL (Take Profit / Stop Loss) Events
use deepbook_indexer::handlers::conditional_order_added_handler::ConditionalOrderAddedHandler;
use deepbook_indexer::handlers::conditional_order_cancelled_handler::ConditionalOrderCancelledHandler;
use deepbook_indexer::handlers::conditional_order_executed_handler::ConditionalOrderExecutedHandler;
use deepbook_indexer::handlers::conditional_order_insufficient_funds_handler::ConditionalOrderInsufficientFundsHandler;

use deepbook_indexer::{DeepbookEnv, NetworkConfig};
use deepbook_schema::MIGRATIONS;
use prometheus::Registry;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use sui_indexer_alt_framework::ingestion::ingestion_client::IngestionClientArgs;
use sui_indexer_alt_framework::ingestion::{ClientArgs, IngestionConfig};
use sui_indexer_alt_framework::{Indexer, IndexerArgs};
use sui_indexer_alt_metrics::db::DbConnectionStatsCollector;
use sui_indexer_alt_metrics::{MetricsArgs, MetricsService};
use sui_pg_db::{Db, DbArgs};

use url::Url;

#[derive(Debug, Clone, clap::ValueEnum)]
pub enum Package {
    /// Index DeepBook core events (order fills, updates, pools, etc.)
    Deepbook,
    /// Index DeepBook margin events (lending, borrowing, liquidations, etc.)
    DeepbookMargin,
}

#[derive(Parser)]
#[clap(rename_all = "kebab-case", author, version)]
struct Args {
    #[command(flatten)]
    db_args: DbArgs,
    #[command(flatten)]
    indexer_args: IndexerArgs,
    #[clap(env, long, default_value = "0.0.0.0:9184")]
    metrics_address: SocketAddr,
    #[clap(
        env,
        long,
        default_value = "postgres://postgres:postgrespw@localhost:5432/deepbook"
    )]
    database_url: Url,
    /// Deepbook environment, defaulted to SUI mainnet.
    #[clap(env, long)]
    env: DeepbookEnv,
    /// Packages to index events for (can specify multiple)
    #[clap(long, value_enum, default_values = ["deepbook", "deepbook-margin"])]
    packages: Vec<Package>,

    // ========== Localnet-specific arguments ==========
    /// Local checkpoint directory path (required for --env localnet).
    /// This should point to where the local Sui node exports checkpoint files.
    #[clap(env, long)]
    local_ingestion_path: Option<PathBuf>,

    /// Core DeepBook package addresses (required for --env localnet).
    /// Comma-separated list of package addresses deployed on localnet.
    /// Example: --core-packages 0xabc...,0xdef...
    #[clap(env, long, value_delimiter = ',')]
    core_packages: Option<Vec<String>>,

    /// Margin package addresses (optional for --env localnet).
    /// Comma-separated list of margin package addresses deployed on localnet.
    #[clap(env, long, value_delimiter = ',')]
    margin_packages: Option<Vec<String>>,
}

#[tokio::main]
async fn main() -> Result<(), anyhow::Error> {
    let _guard = telemetry_subscribers::TelemetryConfig::new()
        .with_env()
        .init();

    let Args {
        db_args,
        indexer_args,
        metrics_address,
        database_url,
        env,
        packages,
        local_ingestion_path,
        core_packages,
        margin_packages,
    } = Args::parse();

    // Build NetworkConfig with validation for localnet
    let config = match env {
        DeepbookEnv::Localnet => {
            let core_pkgs = core_packages.ok_or_else(|| {
                anyhow::anyhow!(
                    "--core-packages is required for --env localnet. \
                    Provide the DeepBook package address(es) deployed on your local network."
                )
            })?;

            if core_pkgs.is_empty() {
                anyhow::bail!("At least one core package address is required for localnet");
            }

            let ingestion_path = local_ingestion_path.ok_or_else(|| {
                anyhow::anyhow!(
                    "--local-ingestion-path is required for --env localnet. \
                    Provide the directory where the local Sui node exports checkpoint files."
                )
            })?;

            NetworkConfig::localnet(core_pkgs, margin_packages, ingestion_path)
        }
        _ => NetworkConfig::from_env(env),
    };

    tracing::info!("Network config: env={:?}, core_packages={}, margin_packages={}",
        config.env,
        config.core_packages.len(),
        config.margin_packages.len()
    );

    let registry = Registry::new_custom(Some("deepbook".into()), None)
        .context("Failed to create Prometheus registry.")?;
    let metrics = MetricsService::new(MetricsArgs { metrics_address }, registry.clone());

    // Prepare the store for the indexer
    let store = Db::for_write(database_url, db_args)
        .await
        .context("Failed to connect to database")?;

    store
        .run_migrations(Some(&MIGRATIONS))
        .await
        .context("Failed to run pending migrations")?;

    registry.register(Box::new(DbConnectionStatsCollector::new(
        Some("deepbook_indexer_db"),
        store.clone(),
    )))?;

    // Build ingestion args based on environment
    let ingestion_args = if config.env == DeepbookEnv::Localnet {
        tracing::info!(
            "Using local checkpoint ingestion from: {:?}",
            config.local_ingestion_path
        );
        IngestionClientArgs {
            remote_store_url: None,
            local_ingestion_path: config.local_ingestion_path.clone(),
            rpc_api_url: None,
            rpc_username: None,
            rpc_password: None,
        }
    } else {
        tracing::info!(
            "Using remote checkpoint ingestion from: {}",
            config.env.remote_store_url()
        );
        IngestionClientArgs {
            remote_store_url: Some(config.env.remote_store_url()),
            local_ingestion_path: None,
            rpc_api_url: None,
            rpc_username: None,
            rpc_password: None,
        }
    };

    let mut indexer = Indexer::new(
        store,
        indexer_args,
        ClientArgs {
            ingestion: ingestion_args,
            streaming: Default::default(),
        },
        IngestionConfig::default(),
        None,
        metrics.registry(),
    )
    .await?;

    // Wrap config in Arc for sharing across handlers
    let config = Arc::new(config);

    // Register handlers based on selected packages
    for package in &packages {
        match package {
            Package::Deepbook => {
                // DeepBook core event handlers
                indexer
                    .concurrent_pipeline(BalancesHandler::new(config.clone()), Default::default())
                    .await?;
                indexer
                    .concurrent_pipeline(DeepBurnedHandler::new(config.clone()), Default::default())
                    .await?;
                indexer
                    .concurrent_pipeline(FlashLoanHandler::new(config.clone()), Default::default())
                    .await?;
                indexer
                    .concurrent_pipeline(OrderFillHandler::new(config.clone()), Default::default())
                    .await?;
                indexer
                    .concurrent_pipeline(OrderUpdateHandler::new(config.clone()), Default::default())
                    .await?;
                indexer
                    .concurrent_pipeline(PoolPriceHandler::new(config.clone()), Default::default())
                    .await?;
                indexer
                    .concurrent_pipeline(ProposalsHandler::new(config.clone()), Default::default())
                    .await?;
                indexer
                    .concurrent_pipeline(RebatesHandler::new(config.clone()), Default::default())
                    .await?;
                indexer
                    .concurrent_pipeline(ReferralFeeEventHandler::new(config.clone()), Default::default())
                    .await?;
                indexer
                    .concurrent_pipeline(StakesHandler::new(config.clone()), Default::default())
                    .await?;
                indexer
                    .concurrent_pipeline(TradeParamsUpdateHandler::new(config.clone()), Default::default())
                    .await?;
                indexer
                    .concurrent_pipeline(VotesHandler::new(config.clone()), Default::default())
                    .await?;
            }
            Package::DeepbookMargin => {
                indexer
                    .concurrent_pipeline(MarginManagerCreatedHandler::new(config.clone()), Default::default())
                    .await?;
                indexer
                    .concurrent_pipeline(LoanBorrowedHandler::new(config.clone()), Default::default())
                    .await?;
                indexer
                    .concurrent_pipeline(LoanRepaidHandler::new(config.clone()), Default::default())
                    .await?;
                indexer
                    .concurrent_pipeline(LiquidationHandler::new(config.clone()), Default::default())
                    .await?;
                indexer
                    .concurrent_pipeline(AssetSuppliedHandler::new(config.clone()), Default::default())
                    .await?;
                indexer
                    .concurrent_pipeline(AssetWithdrawnHandler::new(config.clone()), Default::default())
                    .await?;
                indexer
                    .concurrent_pipeline(MarginPoolCreatedHandler::new(config.clone()), Default::default())
                    .await?;
                indexer
                    .concurrent_pipeline(DeepbookPoolUpdatedHandler::new(config.clone()), Default::default())
                    .await?;
                indexer
                    .concurrent_pipeline(InterestParamsUpdatedHandler::new(config.clone()), Default::default())
                    .await?;
                indexer
                    .concurrent_pipeline(
                        MarginPoolConfigUpdatedHandler::new(config.clone()),
                        Default::default(),
                    )
                    .await?;
                indexer
                    .concurrent_pipeline(MaintainerCapUpdatedHandler::new(config.clone()), Default::default())
                    .await?;
                indexer
                    .concurrent_pipeline(
                        DeepbookPoolRegisteredHandler::new(config.clone()),
                        Default::default(),
                    )
                    .await?;
                indexer
                    .concurrent_pipeline(
                        DeepbookPoolUpdatedRegistryHandler::new(config.clone()),
                        Default::default(),
                    )
                    .await?;
                indexer
                    .concurrent_pipeline(
                        DeepbookPoolConfigUpdatedHandler::new(config.clone()),
                        Default::default(),
                    )
                    .await?;
                indexer
                    .concurrent_pipeline(
                        MaintainerFeesWithdrawnHandler::new(config.clone()),
                        Default::default(),
                    )
                    .await?;
                indexer
                    .concurrent_pipeline(ProtocolFeesWithdrawnHandler::new(config.clone()), Default::default())
                    .await?;
                indexer
                    .concurrent_pipeline(SupplierCapMintedHandler::new(config.clone()), Default::default())
                    .await?;
                indexer
                    .concurrent_pipeline(SupplyReferralMintedHandler::new(config.clone()), Default::default())
                    .await?;
                indexer
                    .concurrent_pipeline(PauseCapUpdatedHandler::new(config.clone()), Default::default())
                    .await?;
                indexer
                    .concurrent_pipeline(ProtocolFeesIncreasedHandler::new(config.clone()), Default::default())
                    .await?;
                indexer
                    .concurrent_pipeline(ReferralFeesClaimedHandler::new(config.clone()), Default::default())
                    .await?;

                // Collateral Events
                indexer
                    .concurrent_pipeline(DepositCollateralHandler::new(config.clone()), Default::default())
                    .await?;
                indexer
                    .concurrent_pipeline(WithdrawCollateralHandler::new(config.clone()), Default::default())
                    .await?;

                // TPSL (Take Profit / Stop Loss) Events
                indexer
                    .concurrent_pipeline(ConditionalOrderAddedHandler::new(config.clone()), Default::default())
                    .await?;
                indexer
                    .concurrent_pipeline(
                        ConditionalOrderCancelledHandler::new(config.clone()),
                        Default::default(),
                    )
                    .await?;
                indexer
                    .concurrent_pipeline(
                        ConditionalOrderExecutedHandler::new(config.clone()),
                        Default::default(),
                    )
                    .await?;
                indexer
                    .concurrent_pipeline(
                        ConditionalOrderInsufficientFundsHandler::new(config.clone()),
                        Default::default(),
                    )
                    .await?;
            }
        }
    }

    let s_indexer = indexer.run().await?;
    let s_metrics = metrics.run().await?;

    s_indexer.attach(s_metrics).main().await?;
    Ok(())
}
