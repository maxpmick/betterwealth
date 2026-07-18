import { Box } from "@mui/material";
import { Typography } from "../mui";

export function DialogHeading({
  eyebrow,
  title,
  description,
}: {
  eyebrow: string;
  title: string;
  description: string;
}) {
  return (
    <Box>
      <Typography variant="overline" color="primary.main">
        {eyebrow}
      </Typography>
      <Typography variant="h3" sx={{ mt: 0.5 }}>
        {title}
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
        {description}
      </Typography>
    </Box>
  );
}
