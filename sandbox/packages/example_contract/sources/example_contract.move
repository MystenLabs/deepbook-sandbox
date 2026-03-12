module example_contract::example_contract;

use deepbook::pool::{Pool};
use deepbook_margin::margin_pool::{MarginPool};
use token::deep::{DEEP};
use pyth::price_info::{PriceInfoObject};
use usdc::usdc::{USDC};

public fun create_example(
    margin: &MarginPool<USDC>,
    pool: &Pool<USDC, DEEP>,
    oracle: &PriceInfoObject,
) {
    return;
}

// For Move coding conventions, see
// https://docs.sui.io/concepts/sui-move-concepts/conventions
