#!/usr/bin/env bash
#
# Setup Stripe Products and Prices for Crewly Pro
#
# Usage:
#   STRIPE_SECRET_KEY=sk_test_xxx ./scripts/setup-stripe-products.sh
#
# This creates three subscription products (Starter, Pro, Max) with monthly
# prices matching the Crewly Pro pricing: $49, $99, $299/month.
#
# After running, copy the printed price IDs into:
#   backend/src/services/payment/stripe.service.ts → STRIPE_PRICE_IDS
#
# Prerequisites: stripe CLI (brew install stripe/stripe-cli/stripe)

set -euo pipefail

if [ -z "${STRIPE_SECRET_KEY:-}" ]; then
  echo "❌ STRIPE_SECRET_KEY is required"
  echo "   Usage: STRIPE_SECRET_KEY=sk_test_xxx $0"
  exit 1
fi

echo "🔧 Setting up Stripe products for Crewly Pro..."
echo ""

# --- Starter Plan ---
echo "📦 Creating Starter plan ($49/month)..."
STARTER_PRODUCT=$(stripe products create \
  --api-key "$STRIPE_SECRET_KEY" \
  -d "name=Crewly Pro Starter" \
  -d "description=3 teams, 5 agents/team, 5 projects, 1 Cloud Relay session" \
  -d "metadata[crewly_plan]=starter" \
  --format json 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")

STARTER_PRICE_MONTHLY=$(stripe prices create \
  --api-key "$STRIPE_SECRET_KEY" \
  -d "product=$STARTER_PRODUCT" \
  -d "unit_amount=4900" \
  -d "currency=usd" \
  -d "recurring[interval]=month" \
  -d "metadata[crewly_plan]=starter" \
  -d "metadata[interval]=month" \
  --format json 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")

STARTER_PRICE_YEARLY=$(stripe prices create \
  --api-key "$STRIPE_SECRET_KEY" \
  -d "product=$STARTER_PRODUCT" \
  -d "unit_amount=3900" \
  -d "currency=usd" \
  -d "recurring[interval]=month" \
  -d "metadata[crewly_plan]=starter" \
  -d "metadata[interval]=year" \
  --format json 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")

echo "  ✅ Starter product: $STARTER_PRODUCT"
echo "  ✅ Monthly price:   $STARTER_PRICE_MONTHLY"
echo "  ✅ Yearly price:    $STARTER_PRICE_YEARLY"
echo ""

# --- Pro Plan ---
echo "📦 Creating Pro plan ($99/month)..."
PRO_PRODUCT=$(stripe products create \
  --api-key "$STRIPE_SECRET_KEY" \
  -d "name=Crewly Pro" \
  -d "description=10 teams, 10 agents/team, 20 projects, 5 Cloud Relay, Cloud Portal with 1-click deploy" \
  -d "metadata[crewly_plan]=pro" \
  --format json 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")

PRO_PRICE_MONTHLY=$(stripe prices create \
  --api-key "$STRIPE_SECRET_KEY" \
  -d "product=$PRO_PRODUCT" \
  -d "unit_amount=9900" \
  -d "currency=usd" \
  -d "recurring[interval]=month" \
  -d "metadata[crewly_plan]=pro" \
  -d "metadata[interval]=month" \
  --format json 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")

PRO_PRICE_YEARLY=$(stripe prices create \
  --api-key "$STRIPE_SECRET_KEY" \
  -d "product=$PRO_PRODUCT" \
  -d "unit_amount=7900" \
  -d "currency=usd" \
  -d "recurring[interval]=month" \
  -d "metadata[crewly_plan]=pro" \
  -d "metadata[interval]=year" \
  --format json 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")

echo "  ✅ Pro product:     $PRO_PRODUCT"
echo "  ✅ Monthly price:   $PRO_PRICE_MONTHLY"
echo "  ✅ Yearly price:    $PRO_PRICE_YEARLY"
echo ""

# --- Max Plan ---
echo "📦 Creating Max plan ($299/month)..."
MAX_PRODUCT=$(stripe products create \
  --api-key "$STRIPE_SECRET_KEY" \
  -d "name=Crewly Pro Max" \
  -d "description=Unlimited teams & agents, thread-based chat portal, team analytics, dedicated support" \
  -d "metadata[crewly_plan]=max" \
  --format json 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")

MAX_PRICE_MONTHLY=$(stripe prices create \
  --api-key "$STRIPE_SECRET_KEY" \
  -d "product=$MAX_PRODUCT" \
  -d "unit_amount=29900" \
  -d "currency=usd" \
  -d "recurring[interval]=month" \
  -d "metadata[crewly_plan]=max" \
  -d "metadata[interval]=month" \
  --format json 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")

MAX_PRICE_YEARLY=$(stripe prices create \
  --api-key "$STRIPE_SECRET_KEY" \
  -d "product=$MAX_PRODUCT" \
  -d "unit_amount=23900" \
  -d "currency=usd" \
  -d "recurring[interval]=month" \
  -d "metadata[crewly_plan]=max" \
  -d "metadata[interval]=year" \
  --format json 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")

echo "  ✅ Max product:     $MAX_PRODUCT"
echo "  ✅ Monthly price:   $MAX_PRICE_MONTHLY"
echo "  ✅ Yearly price:    $MAX_PRICE_YEARLY"
echo ""

# --- Summary ---
echo "========================================="
echo "🎉 Stripe setup complete!"
echo "========================================="
echo ""
echo "Update backend/src/services/payment/stripe.service.ts:"
echo ""
echo "const STRIPE_PRICE_IDS = {"
echo "  'starter_month': '$STARTER_PRICE_MONTHLY',"
echo "  'starter_year': '$STARTER_PRICE_YEARLY',"
echo "  'pro_month': '$PRO_PRICE_MONTHLY',"
echo "  'pro_year': '$PRO_PRICE_YEARLY',"
echo "  'max_month': '$MAX_PRICE_MONTHLY',"
echo "  'max_year': '$MAX_PRICE_YEARLY',"
echo "};"
echo ""
echo "Add to .env:"
echo "  STRIPE_SECRET_KEY=$STRIPE_SECRET_KEY"
echo "  STRIPE_PRICE_STARTER_YEARLY=$STARTER_PRICE_YEARLY"
echo "  STRIPE_PRICE_PRO_YEARLY=$PRO_PRICE_YEARLY"
echo "  STRIPE_PRICE_MAX_YEARLY=$MAX_PRICE_YEARLY"
