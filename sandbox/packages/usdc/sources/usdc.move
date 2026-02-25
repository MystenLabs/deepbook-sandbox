module usdc::usdc;

public struct USDC has drop {}

public struct ProtectedTreasury has key {
    id: UID,
}

public struct TreasuryCapKey has copy, drop, store {}

public fun burn(arg0: &mut ProtectedTreasury, arg1: sui::coin::Coin<USDC>) {
    sui::coin::burn<USDC>(borrow_cap_mut(arg0), arg1);
}

public fun total_supply(arg0: &ProtectedTreasury): u64 {
    sui::coin::total_supply<USDC>(borrow_cap(arg0))
}

fun borrow_cap(arg0: &ProtectedTreasury): &sui::coin::TreasuryCap<USDC> {
    let v0 = TreasuryCapKey {};
    sui::dynamic_object_field::borrow<TreasuryCapKey, sui::coin::TreasuryCap<USDC>>(
        &arg0.id,
        v0,
    )
}

fun borrow_cap_mut(arg0: &mut ProtectedTreasury): &mut sui::coin::TreasuryCap<USDC> {
    let v0 = TreasuryCapKey {};
    sui::dynamic_object_field::borrow_mut<TreasuryCapKey, sui::coin::TreasuryCap<USDC>>(
        &mut arg0.id,
        v0,
    )
}

#[allow(lint(self_transfer))]
fun create_coin(
    arg0: USDC,
    arg1: u64,
    arg2: &mut sui::tx_context::TxContext,
): (ProtectedTreasury, sui::coin::Coin<USDC>) {
    let (currency_initializer, mut cap) = sui::coin_registry::new_currency_with_otw<USDC>(
        arg0,
        6,
        b"USDC".to_string(),
        b"USDC Token".to_string(),
        b"The USDC token is a stablecoin that is pegged to the US dollar.".to_string(),
        b"".to_string(),
        arg2,
    );
    let metadata_cap = currency_initializer.finalize(arg2);
    sui::transfer::public_transfer(metadata_cap, arg2.sender());
    let mut protected_treasury = ProtectedTreasury { id: sui::object::new(arg2) };

    let coin = sui::coin::mint<USDC>(&mut cap, arg1, arg2);
    sui::dynamic_object_field::add<TreasuryCapKey, sui::coin::TreasuryCap<USDC>>(
        &mut protected_treasury.id,
        TreasuryCapKey {},
        cap,
    );

    (protected_treasury, coin)
}

#[allow(lint(share_owned))]
fun init(arg0: USDC, arg1: &mut TxContext) {
    let (v0, v1) = create_coin(arg0, 10000000000000000, arg1);
    sui::transfer::share_object<ProtectedTreasury>(v0);
    sui::transfer::public_transfer<sui::coin::Coin<USDC>>(v1, sui::tx_context::sender(arg1));
}
