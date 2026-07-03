/**
 * payment.controller.ts — Midtrans Payment Webhook & Checkout
 *
 * Handles:
 *   POST /api/payment/checkout  → Create Snap transaction, return payment URL
 *   POST /api/payment/webhook   → Receive & process Midtrans webhook notifications
 *   GET  /api/payment/status    → Get current user's membership status
 */
import type { Request, Response, NextFunction } from 'express';
import { supabaseAdmin } from '../config/supabaseClient.js';
import {
  createSnapTransaction,
  verifyWebhookSignature,
  isPaymentSuccessful,
  MEMBERSHIP_PLANS,
  type MidtransWebhookPayload,
} from '../services/midtrans.service.js';
import { createError } from '../middleware/errorHandler.js';
import { addMonths, format } from 'date-fns';

// ─── POST /api/payment/checkout ───────────────────────────────────────────────

export async function createCheckout(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const userId = req.user!.id;
    const { plan_id } = req.body;

    if (!plan_id || !MEMBERSHIP_PLANS[plan_id as string]) {
      throw createError(
        400,
        `Invalid plan_id. Choose from: ${Object.keys(MEMBERSHIP_PLANS).join(', ')}`
      );
    }

    // Fetch user details for Midtrans customer info
    const { data: user, error: userError } = await supabaseAdmin
      .from('users')
      .select('email, name')
      .eq('id', userId)
      .single();

    if (userError || !user) {
      throw createError(404, 'User not found');
    }

    // Generate a unique order ID: format: AG-{userId.slice(0,8)}-{timestamp}
    const orderId = `AG-${userId.slice(0, 8)}-${Date.now()}`;

    const snapData = await createSnapTransaction(
      orderId,
      userId,
      user.email,
      user.name ?? 'AetherGym Member',
      plan_id
    );

    // Create a pending payment_receipt record.
    // We also store plan_id here so the webhook can read it back
    // without needing Midtrans custom_field parsing.
    const { error: receiptError } = await supabaseAdmin
      .from('payment_receipts')
      .insert({
        user_id: userId,
        transaction_id: orderId,
        amount: MEMBERSHIP_PLANS[plan_id].price,
        plan_id: plan_id,          // ← stored for webhook use
        payment_status: 'pending',
      });

    if (receiptError) {
      console.error('[Checkout] Failed to create payment receipt:', receiptError);
      // Non-fatal: the webhook will handle the final state
    }

    res.json({
      success: true,
      data: {
        order_id: orderId,
        snap_token: snapData.token,
        redirect_url: snapData.redirect_url,
        plan: MEMBERSHIP_PLANS[plan_id],
      },
    });
  } catch (err) {
    next(err);
  }
}

export async function handleWebhook(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const payload = req.body as MidtransWebhookPayload;

    // ── Security: Verify signature ───────────────────────────────────────────
    const isValid = verifyWebhookSignature(payload);
    if (!isValid) {
      console.error('[Webhook] Invalid signature! Possible spoofed request. Payload:', payload);
      // Return 200 to prevent Midtrans from retrying, but don't process
      res.status(200).json({ received: true, processed: false, reason: 'Invalid signature' });
      return;
    }

    console.log(`[Webhook] Received: order=${payload.order_id} status=${payload.transaction_status}`);

    // ── Find the pending payment receipt ─────────────────────────────────────
    const { data: receipt, error: receiptError } = await supabaseAdmin
      .from('payment_receipts')
      .select('id, user_id, payment_status')
      .eq('transaction_id', payload.order_id)
      .single();

    if (receiptError || !receipt) {
      console.error('[Webhook] Receipt not found for order:', payload.order_id);
      // Return 200 so Midtrans doesn't retry — we can't find this order
      res.status(200).json({ received: true, processed: false, reason: 'Receipt not found' });
      return;
    }

    // ── Idempotency check: skip if already processed ──────────────────────────
    if (receipt.payment_status === 'settlement') {
      console.log(`[Webhook] Already processed order ${payload.order_id}. Skipping.`);
      res.status(200).json({ received: true, processed: false, reason: 'Already processed' });
      return;
    }

    // ── Update payment_receipt ────────────────────────────────────────────────
    const { error: updateError } = await supabaseAdmin
      .from('payment_receipts')
      .update({
        payment_status: payload.transaction_status,
        payment_method: payload.payment_type,
        raw_webhook: payload,
        paid_at: isPaymentSuccessful(payload) ? new Date().toISOString() : null,
      })
      .eq('id', receipt.id);

    if (updateError) {
      console.error('[Webhook] Failed to update receipt:', updateError);
    }

    // ── If payment succeeded, upgrade the user to member ─────────────────────
    if (isPaymentSuccessful(payload)) {
      const userId = receipt.user_id;

      // Read the plan_id that was stored in payment_receipts during checkout.
      // Fall back to 'monthly' only if the column is missing (old records).
      const { data: fullReceipt } = await supabaseAdmin
        .from('payment_receipts')
        .select('plan_id')
        .eq('id', receipt.id)
        .single();

      const planId = (fullReceipt?.plan_id as string) ?? 'monthly';
      const plan = MEMBERSHIP_PLANS[planId] ?? MEMBERSHIP_PLANS['monthly'];
      const startDate = new Date();
      const endDate = addMonths(startDate, plan.durationMonths);

      // Step 1: Update user role to 'member'
      const { error: roleError } = await supabaseAdmin
        .from('users')
        .update({ role: 'member' })
        .eq('id', userId);

      if (roleError) {
        console.error('[Webhook] Failed to update user role:', roleError);
      }

      // Step 2: Deactivate any existing active memberships for this user
      //         (a user shouldn't have two overlapping active memberships)
      await supabaseAdmin
        .from('memberships')
        .update({ status: 'superseded' })
        .eq('user_id', userId)
        .eq('status', 'active');

      // Step 3: Insert a fresh membership row.
      //   WHY INSERT (not upsert): The memberships table allows multiple rows
      //   per user (history of past memberships). There is no UNIQUE constraint
      //   on user_id, so upsert+onConflict throws PostgreSQL error 42P10.
      const { error: membershipError } = await supabaseAdmin
        .from('memberships')
        .insert({
          user_id: userId,
          status: 'active',
          plan_name: plan.name,
          start_date: format(startDate, 'yyyy-MM-dd'),
          end_date: format(endDate, 'yyyy-MM-dd'),
        });

      if (membershipError) {
        console.error('[Webhook] Failed to create membership:', membershipError);
      } else {
        console.log(
          `[Webhook] ✓ User ${userId} upgraded to member (${planId}).` +
          ` Membership valid until ${format(endDate, 'yyyy-MM-dd')}`
        );
      }
    }

    // Always return 200 OK so Midtrans knows we received the notification
    res.status(200).json({ received: true, processed: true });
  } catch (err) {
    // Still return 200 to Midtrans to avoid retry loops, but log the error
    console.error('[Webhook] Unhandled error:', err);
    res.status(200).json({ received: true, processed: false, reason: 'Internal error' });
  }
}

// ─── GET /api/payment/status ──────────────────────────────────────────────────

export async function getMembershipStatus(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const userId = req.user!.id;

    const { data: membership, error } = await supabaseAdmin
      .from('memberships')
      .select('*')
      .eq('user_id', userId)
      .eq('status', 'active')
      .order('end_date', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      throw createError(500, `Failed to fetch membership: ${error.message}`);
    }

    const { data: user } = await supabaseAdmin
      .from('users')
      .select('role, target_calories')
      .eq('id', userId)
      .single();

    res.json({
      success: true,
      data: {
        role: user?.role ?? 'guest',
        target_calories: user?.target_calories ?? 2000,
        membership: membership ?? null,
        is_active_member: membership !== null,
      },
    });
  } catch (err) {
    next(err);
  }
}
