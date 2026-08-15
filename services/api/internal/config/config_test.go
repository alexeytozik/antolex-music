package config

import "testing"

func TestLoadIncludesDefaultOwnerEmail(t *testing.T) {
	t.Setenv("ADMIN_EMAILS", "")

	cfg := Load()
	if len(cfg.AdminEmails) != 1 || cfg.AdminEmails[0] != "tozikalexey@gmail.com" {
		t.Fatalf("AdminEmails=%v; want the default owner", cfg.AdminEmails)
	}
}

func TestLoadNormalizesAndDeduplicatesAdminEmails(t *testing.T) {
	t.Setenv("ADMIN_EMAILS", " Owner@Example.com,second@example.com, owner@example.com ")

	cfg := Load()
	want := []string{defaultAdminEmail, "owner@example.com", "second@example.com"}
	if len(cfg.AdminEmails) != len(want) {
		t.Fatalf("AdminEmails=%v; want %v", cfg.AdminEmails, want)
	}
	for index := range want {
		if cfg.AdminEmails[index] != want[index] {
			t.Fatalf("AdminEmails=%v; want %v", cfg.AdminEmails, want)
		}
	}
}

func TestLoadCannotDropDefaultOwnerWithMalformedList(t *testing.T) {
	t.Setenv("ADMIN_EMAILS", ", ,")

	cfg := Load()
	if len(cfg.AdminEmails) != 1 || cfg.AdminEmails[0] != defaultAdminEmail {
		t.Fatalf("AdminEmails=%v; want protected default owner", cfg.AdminEmails)
	}
}
