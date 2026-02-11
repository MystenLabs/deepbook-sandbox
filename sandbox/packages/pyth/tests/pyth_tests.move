#[test_only]
module pyth::pyth_tests;

use pyth::pyth;
use pyth::price_info::{Self, PriceInfo};
use pyth::price_feed;
use pyth::price::{Self, Price};
use pyth::price_identifier;
use pyth::i64;
use sui::test_scenario::{Self as scenario, return_shared};

const ADMIN: address = @0x1;

fun make_id_bytes(seed: u8): vector<u8> {
    let mut bytes = vector::empty<u8>();
    let mut i = 0u64;
    while (i < 31) {
        vector::push_back(&mut bytes, 0u8);
        i = i + 1;
    };
    vector::push_back(&mut bytes, seed);
    bytes
}

fun make_price(magnitude: u64, timestamp: u64): Price {
    let mag = i64::new(magnitude, false);
    price::new(mag, 0, i64::new(0, false), timestamp)
}

fun make_price_info_with_id(attestation_time: u64, arrival_time: u64, magnitude: u64, timestamp: u64, id_seed: u8): PriceInfo {
    let id = price_identifier::from_byte_vec(make_id_bytes(id_seed));
    let p = make_price(magnitude, timestamp);
    let feed = price_feed::new(id, p, p);
    price_info::new_price_info(attestation_time, arrival_time, feed)
}

#[test]
fun test_create_price_feeds() {
    let mut sc = scenario::begin(ADMIN);

    let mut infos = vector::empty<PriceInfo>();
    vector::push_back(&mut infos, make_price_info_with_id(1, 2, 1000, 100, 0));
    vector::push_back(&mut infos, make_price_info_with_id(3, 4, 1000, 200, 1));
    pyth::create_price_feeds(infos, sc.ctx());

    sc.next_tx(ADMIN);
    let obj1 = sc.take_shared<price_info::PriceInfoObject>();
    let obj2 = sc.take_shared<price_info::PriceInfoObject>();

    let price1 = pyth::get_price_unsafe(&obj1);
    let price2 = pyth::get_price_unsafe(&obj2);
    let t1 = price::get_timestamp(&price1);
    let t2 = price::get_timestamp(&price2);

    assert!(i64::get_magnitude_if_positive(&price::get_price(&price1)) == 1000, 0);
    assert!(i64::get_magnitude_if_positive(&price::get_price(&price2)) == 1000, 0);
    assert!((t1 == 100 && t2 == 200) || (t1 == 200 && t2 == 100), 0);

    return_shared(obj1);
    return_shared(obj2);
    sc.end();
}

#[test]
fun test_update_single_price_feed_fresh_update() {
    let mut sc = scenario::begin(ADMIN);

    let mut infos = vector::empty<PriceInfo>();
    vector::push_back(&mut infos, make_price_info_with_id(1, 2, 1000, 100, 0));
    pyth::create_price_feeds(infos, sc.ctx());

    sc.next_tx(ADMIN);
    let mut obj = sc.take_shared<price_info::PriceInfoObject>();
    let newer = make_price_info_with_id(3, 4, 2000, 200, 0);
    pyth::update_single_price_feed(&newer, &mut obj);
    return_shared(obj);

    sc.next_tx(ADMIN);
    let obj2 = sc.take_shared<price_info::PriceInfoObject>();
    let price = pyth::get_price_unsafe(&obj2);
    assert!(price::get_timestamp(&price) == 200, 0);
    assert!(i64::get_magnitude_if_positive(&price::get_price(&price)) == 2000, 0);
    return_shared(obj2);
    sc.end();
}
