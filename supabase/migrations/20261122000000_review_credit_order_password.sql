-- Verifikasi transfer pesanan kredit kini WAJIB lewat worker dengan password
-- aksi admin. Fungsinya dibuat terpisah dari review_credit_order (yang memakai
-- klaim JWT) karena worker memanggilnya dengan service_role tanpa klaim JWT;
-- p_admin_id diisi dari sesi worker yang sudah diverifikasi password-nya.
create or replace function public.admin_review_credit_order(p_order_id uuid, p_approve boolean, p_admin_id uuid)
returns public.credit_orders language plpgsql security definer set search_path = '' as $$
declare v_order public.credit_orders%rowtype;
begin
  if p_admin_id is null then raise exception 'Administrator only'; end if;
  if p_approve is null then raise exception 'Keputusan tidak valid'; end if;
  select * into v_order from public.credit_orders where id = p_order_id for update;
  if not found then raise exception 'Pesanan tidak ditemukan'; end if;
  -- Retry yang identik aman; keputusan yang bertentangan ditolak.
  if (p_approve and v_order.status = 'approved') or (not p_approve and v_order.status = 'rejected') then return v_order; end if;
  if v_order.status <> 'pending_review' then raise exception 'Pesanan tidak menunggu pemeriksaan'; end if;
  if p_approve then
    insert into public.credit_wallets (user_id, balance) values (v_order.user_id, v_order.credits)
      on conflict (user_id) do update set balance = public.credit_wallets.balance + excluded.balance, updated_at = now();
    insert into public.credit_ledger (user_id, order_id, delta, description)
      values (v_order.user_id, v_order.id, v_order.credits, 'Pembelian: ' || v_order.package_name);
  end if;
  update public.credit_orders set status = case when p_approve then 'approved' else 'rejected' end,
    reviewed_at = now(), reviewed_by = p_admin_id where id = v_order.id returning * into v_order;
  return v_order;
end;
$$;

revoke all on function public.admin_review_credit_order(uuid, boolean, uuid) from public, anon, authenticated;
grant execute on function public.admin_review_credit_order(uuid, boolean, uuid) to service_role;

-- Jalur langsung dari browser ditutup: semuanya lewat /api/admin/review-order.
revoke execute on function public.review_credit_order(uuid, boolean) from authenticated;
