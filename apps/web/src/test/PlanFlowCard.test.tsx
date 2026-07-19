import { CheckCircleRounded, PaymentsRounded } from "@mui/icons-material";
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { PlanFlowCard } from "../components/PlanFlowCard";
import { AppProviders } from "../contexts";

describe("PlanFlowCard", () => {
  it("presents each live planning stage as an accessible destination", () => {
    render(
      <AppProviders>
        <MemoryRouter>
          <PlanFlowCard
            title="Your money loop"
            testId="money-loop"
            steps={[
              {
                id: "income",
                label: "Income",
                value: "$2,600",
                detail: "Expected take-home",
                icon: <PaymentsRounded />,
                to: "/budget",
                status: "Mapped",
                statusTone: "positive",
              },
              {
                id: "ready",
                label: "Ready",
                value: "18/20",
                detail: "Categorized and reviewed",
                icon: <CheckCircleRounded />,
                to: "/automation",
                status: "Two to review",
                statusTone: "warning",
              },
            ]}
            footer="No invented completion score."
          />
        </MemoryRouter>
      </AppProviders>,
    );

    const flow = screen.getByTestId("money-loop");
    expect(within(flow).getByRole("heading", { name: "Your money loop" })).toBeInTheDocument();
    expect(within(flow).getByRole("list")).toBeInTheDocument();
    expect(within(flow).getAllByRole("listitem")).toHaveLength(2);
    expect(within(flow).getByRole("link", { name: /01 · income/i })).toHaveAttribute(
      "href",
      "/budget",
    );
    expect(within(flow).getByRole("link", { name: /02 · ready/i })).toHaveAttribute(
      "href",
      "/automation",
    );
    expect(within(flow).getByText("No invented completion score.")).toBeInTheDocument();
  });
});
